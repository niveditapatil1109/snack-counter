import { RefillState as S, transition } from '../domain/refill.js';
import { addDays } from '../domain/time.js';

/**
 * Talks to the external HR system: files the claim as soon as the receipt is
 * in, retries when HR is down, and follows the claim until it is paid.
 * This removes the "I'll file it later" delay behind slow reimbursements.
 */
export class ClaimsService {
  constructor({ store, chat, hr, clock, offices, rules }) {
    this.store = store;
    this.chat = chat;
    this.hr = hr;
    this.clock = clock;
    this.offices = offices;
    this.rules = rules;
  }

  /**
   * File the reimbursement claim for a REFILLED refill.
   * HR being down never throws: the refill stays REFILLED, the error is
   * recorded, and the scheduler retries later.
   */
  async submit(refill) {
    const office = this.offices[refill.officeId];
    const { buyerId, amount, receiptImage, items } = refill.purchase;

    let claimId;
    try {
      ({ claimId } = await this.hr.createClaim({
        idempotencyKey: refill.id, //  one refill = one claim, however many times we retry
        employeeId: buyerId,
        amount, //                     receipt currency; HR pays out in the buyer's payroll currency
        description: `Snack refill ${refill.id} for the ${office.name} office${items.length ? `: ${items.join(', ')}` : ''}`,
        receiptImage,
      }));
    } catch (error) {
      return this.#recordFailedAttempt(refill.id, error);
    }

    // Re-read after the await: another run may have filed it meanwhile.
    const latest = this.store.getRefill(refill.id);
    if (latest.state !== S.REFILLED) return latest;

    const now = this.clock.now();
    const submitted = this.store.saveRefill(
      transition(latest, S.CLAIM_SUBMITTED, {
        at: now,
        note: `HR claim ${claimId} created`,
        changes: {
          claim: { ...latest.claim, hrClaimId: claimId, attempts: latest.claim.attempts + 1, lastError: null, submittedAt: now },
        },
      }),
    );
    await this.chat.sendDirect(
      buyerId,
      `Your reimbursement claim for ${amount} has been filed with HR (${claimId}). I'll let you know when it is approved.`,
    );
    return submitted;
  }

  async #recordFailedAttempt(refillId, error) {
    const latest = this.store.getRefill(refillId);
    if (latest.state !== S.REFILLED) return latest; // filed by another run meanwhile
    const attempts = latest.claim.attempts + 1;
    const failed = this.store.saveRefill(
      transition(latest, S.REFILLED, {
        at: this.clock.now(),
        note: `HR submission failed (attempt ${attempts}): ${error.message}`,
        changes: { claim: { ...latest.claim, attempts, lastError: error.message } },
      }),
    );
    if (attempts === this.rules.hrMaxAttempts) {
      const office = this.offices[latest.officeId];
      await this.chat.sendDirect(
        office.adminId,
        `Could not file the HR claim for ${refillId} after ${attempts} attempts (${error.message}). Please file it by hand.`,
      );
    }
    return failed;
  }

  /** Scheduler job: retry claims that HR did not accept yet. */
  async retryFailedSubmissions() {
    for (const { id } of this.store.listRefills()) {
      const refill = this.store.getRefill(id); // re-read: an earlier iteration may have awaited
      if (refill.state === S.REFILLED && refill.claim.attempts < this.rules.hrMaxAttempts) {
        await this.submit(refill);
      }
    }
  }

  /** Scheduler job: ask HR about every open claim and act on the answer. */
  async syncStatuses() {
    for (const { id } of this.store.listRefills()) {
      const refill = this.store.getRefill(id);
      if (refill.state !== S.CLAIM_SUBMITTED) continue;

      let status;
      try {
        status = await this.hr.getClaimStatus(refill.claim.hrClaimId);
      } catch {
        continue; // HR is down; ask again on the next run
      }

      const latest = this.store.getRefill(id); // re-read after the await
      if (latest.state !== S.CLAIM_SUBMITTED) continue;

      if (status === 'APPROVED') await this.#markReimbursed(latest);
      else if (status === 'REJECTED') await this.#markRejected(latest);
      else await this.#nudgeIfSlow(latest);
    }
  }

  async #markReimbursed(refill) {
    const now = this.clock.now();
    this.store.saveRefill(
      transition(refill, S.REIMBURSED, {
        at: now,
        note: 'HR approved',
        changes: { claim: { ...refill.claim, decidedAt: now } },
      }),
    );
    await this.chat.sendDirect(
      refill.purchase.buyerId,
      `Good news: HR approved claim ${refill.claim.hrClaimId} for ${refill.purchase.amount}. It will be paid in your payroll currency.`,
    );
  }

  async #markRejected(refill) {
    const now = this.clock.now();
    const office = this.offices[refill.officeId];
    this.store.saveRefill(
      transition(refill, S.CLAIM_REJECTED, {
        at: now,
        note: 'HR rejected',
        changes: { claim: { ...refill.claim, decidedAt: now } },
      }),
    );
    await this.chat.sendDirect(
      refill.purchase.buyerId,
      `HR rejected claim ${refill.claim.hrClaimId}. The office admin has been told and will follow up with you.`,
    );
    await this.chat.sendDirect(
      office.adminId,
      `HR rejected claim ${refill.claim.hrClaimId} (${refill.id}, ${refill.purchase.amount}). Please follow up with the buyer.`,
    );
  }

  /** HR promises 1-10 days. Past that, nudge the admin once. */
  async #nudgeIfSlow(refill) {
    const now = this.clock.now();
    const nudgeAt = addDays(refill.claim.submittedAt, this.rules.claimNudgeAfterDays);
    if (refill.claim.nudgedAt || now < nudgeAt) return;

    const office = this.offices[refill.officeId];
    this.store.saveRefill(
      transition(refill, S.CLAIM_SUBMITTED, {
        at: now,
        note: 'Admin nudged about slow claim',
        changes: { claim: { ...refill.claim, nudgedAt: now } },
      }),
    );
    await this.chat.sendDirect(
      office.adminId,
      `Claim ${refill.claim.hrClaimId} (${refill.id}) has been waiting more than ${this.rules.claimNudgeAfterDays} days. Could you check with HR?`,
    );
  }
}
