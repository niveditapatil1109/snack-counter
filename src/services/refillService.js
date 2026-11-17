import { pickBuyer } from '../domain/assignmentPolicy.js';
import { checkBudget } from '../domain/budget.js';
import {
  ConcurrentUpdateError,
  NotAllowedError,
  NotFoundError,
  RefillUnavailableError,
  ValidationError,
} from '../domain/errors.js';
import { Money } from '../domain/money.js';
import { createRefill, isOpen, RefillState as S, transition } from '../domain/refill.js';
import { addHours } from '../domain/time.js';

/**
 * The refill lifecycle: report empty -> choose who buys -> commit ->
 * hand over on timeout -> receipt -> hand off to ClaimsService.
 *
 * Rule of thumb used everywhere in this class: change state FIRST (read,
 * check, write, with no `await` in between), THEN send chat messages. Node
 * runs one piece of JS at a time, so a read-check-write with no `await` cannot
 * be interleaved with another request. The store's version check covers the
 * multi-server case.
 */
export class RefillService {
  constructor({ store, chat, clock, claims, offices, rules }) {
    this.store = store;
    this.chat = chat;
    this.clock = clock;
    this.claims = claims;
    this.offices = offices;
    this.rules = rules;
  }

  // ---------------------------------------------------------------------------
  // 1. Someone reports the box is empty
  // ---------------------------------------------------------------------------

  async reportEmpty(officeId, reporterId, { ranOut = [] } = {}) {
    const office = this.#office(officeId);
    const now = this.clock.now();

    // Prevents two buyers: an office has at most ONE open refill.
    // A second report joins the existing refill instead of starting another.
    const open = this.store.findOpenRefill(officeId);
    if (open) {
      const updated = this.store.saveRefill(
        transition(open, open.state, {
          at: now,
          by: reporterId,
          note: 'Reported empty again',
          changes: {
            reportedBy: unique([...open.reportedBy, reporterId]),
            ranOut: unique([...open.ranOut, ...ranOut]),
          },
        }),
      );
      await this.chat.sendDirect(reporterId, `Thanks! A refill for ${office.name} is already in progress (${open.id}).`);
      return updated;
    }

    const refill = this.store.insertRefill(
      createRefill({ id: this.store.nextRefillId(), officeId, reportedBy: reporterId, ranOut, now }),
    );
    // Offer first (its state change happens before its first await), then tell the channel.
    const offered = await this.#offerToNextVolunteer(refill, 'Box reported empty');
    await this.chat.postToChannel(officeId, `The ${office.name} snack box is empty. A volunteer is being found (${refill.id}).`);
    return offered;
  }

  // ---------------------------------------------------------------------------
  // 2. Budget check + choose who buys
  // ---------------------------------------------------------------------------

  async #offerToNextVolunteer(refill, reason) {
    const office = this.#office(refill.officeId);
    const now = this.clock.now();
    const allRefills = this.store.listRefills();

    // Budget check BEFORE asking anyone to spend their own money.
    const budget = checkBudget(office, allRefills, now);
    if (!budget.canAfford && !refill.budgetOverride) {
      return this.#blockOnBudget(refill, budget.remaining, now);
    }
    const cap = refill.budgetOverride ? office.maxPurchase : budget.cap;

    // Ask named people one at a time; after maxDirectOffers, open it to everyone.
    const candidate =
      refill.triedIds.length < this.rules.maxDirectOffers
        ? pickBuyer({
            office,
            volunteers: this.store.listVolunteers(),
            refills: allRefills,
            triedIds: refill.triedIds,
            now,
            rules: this.rules,
          })
        : null;

    if (!candidate) {
      return this.#escalate(refill, cap, now);
    }

    const offered = this.store.saveRefill(
      transition(refill, S.OFFERED, {
        at: now,
        note: `${reason}; offered to ${candidate.id}`,
        changes: {
          assigneeId: candidate.id,
          cap,
          offerExpiresAt: addHours(now, this.rules.offerTimeoutHours),
          purchaseDueAt: null,
        },
      }),
    );
    await this.chat.sendDirect(
      candidate.id,
      `Hi ${candidate.name}, the ${office.name} snack box is empty and you're up next (${refill.id}). ` +
        `Budget: up to ${cap}. Please accept or decline within ${this.rules.offerTimeoutHours} hours.`,
    );
    return offered;
  }

  async #blockOnBudget(refill, remaining, now) {
    const office = this.#office(refill.officeId);
    const blocked = this.store.saveRefill(
      transition(refill, S.BLOCKED_BUDGET, {
        at: now,
        note: `Only ${remaining} left this month`,
        changes: { assigneeId: null, offerExpiresAt: null, purchaseDueAt: null },
      }),
    );
    await this.chat.sendDirect(
      office.adminId,
      `The ${office.name} snack box is empty but only ${remaining} of the monthly budget is left ` +
        `(minimum useful purchase ${office.minPurchase}). Approve going over budget for ${refill.id}, or cancel it.`,
    );
    return blocked;
  }

  async #escalate(refill, cap, now) {
    const office = this.#office(refill.officeId);
    const escalated = this.store.saveRefill(
      transition(refill, S.ESCALATED, {
        at: now,
        note: `No volunteer after ${refill.triedIds.length} offer(s)`,
        changes: { assigneeId: null, cap, offerExpiresAt: null, purchaseDueAt: null },
      }),
    );
    await this.chat.postToChannel(
      office.id,
      `Help wanted: the ${office.name} snack box is still empty. The first volunteer to accept ${refill.id} gets it (budget up to ${cap}).`,
    );
    await this.chat.sendDirect(
      office.adminId,
      `${refill.id} (${office.name}) found no volunteer after ${refill.triedIds.length} offer(s). It is now open to everyone.`,
    );
    return escalated;
  }

  // ---------------------------------------------------------------------------
  // 3. Commit. Enforces "two people cannot both commit to the same refill".
  // ---------------------------------------------------------------------------

  async acceptRefill(refillId, employeeId) {
    const refill = this.store.getRefill(refillId);
    const now = this.clock.now();

    if (refill.state === S.OFFERED && refill.assigneeId !== employeeId) {
      throw new NotAllowedError(`${refillId} was offered to someone else.`);
    }
    if (refill.state !== S.OFFERED && refill.state !== S.ESCALATED) {
      throw new RefillUnavailableError(`${refillId} is no longer available (it is ${refill.state}).`);
    }
    const volunteer = this.#activeVolunteer(employeeId);

    // Once this write succeeds the refill is COMMITTED, so every other accept
    // fails the state check above. A write based on an older version is
    // rejected by the store (optimistic lock).
    const committed = this.store.saveRefill(
      transition(refill, S.COMMITTED, {
        at: now,
        by: employeeId,
        note: 'Accepted',
        changes: {
          assigneeId: employeeId,
          offerExpiresAt: null,
          purchaseDueAt: addHours(now, this.rules.purchaseTimeoutHours),
        },
      }),
    );

    const office = this.#office(refill.officeId);
    await this.chat.sendDirect(
      employeeId,
      `Thanks ${volunteer.name}, ${refillId} is yours. Spend up to ${refill.cap} and upload the receipt within ${this.rules.purchaseTimeoutHours} hours.`,
    );
    await this.chat.postToChannel(office.id, `${volunteer.name} is refilling the ${office.name} box. Nobody else needs to buy.`);
    return committed;
  }

  async declineRefill(refillId, employeeId) {
    const refill = this.store.getRefill(refillId);
    if (refill.state !== S.OFFERED || refill.assigneeId !== employeeId) {
      throw new NotAllowedError(`You have no open offer for ${refillId}.`);
    }
    const next = await this.#passToNextVolunteer(refill, `${employeeId} declined`);
    await this.chat.sendDirect(employeeId, `No problem, I've asked someone else to handle ${refillId}.`);
    return next;
  }

  // ---------------------------------------------------------------------------
  // 4. Timeouts. Called by the scheduler every few minutes. Deadlines are
  //    stored on the refill (data, not setTimeout), so a restart loses nothing.
  // ---------------------------------------------------------------------------

  async checkTimeouts() {
    const now = this.clock.now();

    for (const { id } of this.store.listRefills()) {
      const refill = this.store.getRefill(id); // re-read: an earlier iteration may have awaited
      try {
        if (refill.state === S.OFFERED && now >= refill.offerExpiresAt) {
          await this.#passToNextVolunteer(refill, `${refill.assigneeId} did not answer in time`);
          await this.chat.sendDirect(refill.assigneeId, `No answer on ${id}, so it went to someone else. Nothing to do.`);
        } else if (refill.state === S.COMMITTED && now >= refill.purchaseDueAt) {
          await this.#passToNextVolunteer(refill, `${refill.assigneeId} did not upload a receipt in time`);
          await this.chat.sendDirect(
            refill.assigneeId,
            `${id} was handed to someone else because no receipt arrived within ${this.rules.purchaseTimeoutHours} hours. ` +
              `Please do NOT buy snacks for it now. If you already did, contact the office admin.`,
          );
        }
      } catch (error) {
        // Someone accepted at the same moment: their write won. Re-check on the next run.
        if (!(error instanceof ConcurrentUpdateError)) throw error;
      }
    }
  }

  /** The current assignee is out. Remember them so they are not asked again, then ask the next person. */
  #passToNextVolunteer(refill, reason) {
    return this.#offerToNextVolunteer({ ...refill, triedIds: [...refill.triedIds, refill.assigneeId] }, reason);
  }

  // ---------------------------------------------------------------------------
  // 5. Receipt uploaded: the box is full. The claim goes to HR right away.
  // ---------------------------------------------------------------------------

  async completeRefill(refillId, employeeId, { amount, receiptImage, items = [] }) {
    const refill = this.store.getRefill(refillId);
    const office = this.#office(refill.officeId);
    const now = this.clock.now();

    if (refill.state !== S.COMMITTED || refill.assigneeId !== employeeId) {
      throw new NotAllowedError(`Only the volunteer currently buying ${refillId} can complete it.`);
    }
    if (!(amount instanceof Money) || amount.minor <= 0) {
      throw new ValidationError('Amount must be a positive Money value.');
    }
    if (amount.currency !== office.currency) {
      throw new ValidationError(`The ${office.name} counter is budgeted in ${office.currency}, but the receipt is in ${amount.currency}.`);
    }
    if (!receiptImage) {
      throw new ValidationError('A receipt image is required for reimbursement.');
    }

    // Small overspends are fine. Bigger ones are flagged, but never block
    // reimbursement: the volunteer has already paid with their own money.
    const tolerated = new Money(Math.round(refill.cap.minor * (1 + this.rules.overCapTolerance)), office.currency);
    const overCap = amount.isGreaterThan(tolerated);

    const refilled = this.store.saveRefill(
      transition(refill, S.REFILLED, {
        at: now,
        by: employeeId,
        note: `Bought for ${amount}`,
        changes: {
          purchaseDueAt: null,
          purchase: { buyerId: employeeId, amount, receiptImage, items, purchasedAt: now, overCap },
          claim: { hrClaimId: null, attempts: 0, lastError: null, submittedAt: null, decidedAt: null, nudgedAt: null },
        },
      }),
    );

    const buyer = this.store.getVolunteer(employeeId);
    await this.chat.postToChannel(office.id, `The ${office.name} box has been refilled by ${buyer.name}. Thank you!`);
    if (overCap) {
      await this.chat.sendDirect(
        office.adminId,
        `Heads-up: ${refillId} cost ${amount}, above the cap of ${refill.cap}. The claim was still filed because ${buyer.name} has already paid.`,
      );
    }
    return this.claims.submit(refilled);
  }

  // ---------------------------------------------------------------------------
  // 6. Admin actions
  // ---------------------------------------------------------------------------

  async approveOverBudget(refillId, adminId) {
    const refill = this.store.getRefill(refillId);
    this.#assertAdmin(refill, adminId);
    if (refill.state !== S.BLOCKED_BUDGET) {
      throw new RefillUnavailableError(`${refillId} is not waiting for budget approval.`);
    }
    return this.#offerToNextVolunteer({ ...refill, budgetOverride: true }, 'Admin approved going over budget');
  }

  async cancelRefill(refillId, adminId, reason) {
    const refill = this.store.getRefill(refillId);
    this.#assertAdmin(refill, adminId);
    if (!isOpen(refill)) {
      throw new RefillUnavailableError(`${refillId} cannot be cancelled (it is ${refill.state}).`);
    }
    const cancelled = this.store.saveRefill(
      transition(refill, S.CANCELLED, {
        at: this.clock.now(),
        by: adminId,
        note: reason,
        changes: { assigneeId: null, offerExpiresAt: null, purchaseDueAt: null },
      }),
    );
    if (refill.assigneeId) {
      await this.chat.sendDirect(refill.assigneeId, `${refillId} was cancelled (${reason}). Please don't buy snacks for it.`);
    }
    return cancelled;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  #office(officeId) {
    const office = this.offices[officeId];
    if (!office) throw new NotFoundError(`Unknown office ${officeId}`);
    return office;
  }

  #activeVolunteer(employeeId) {
    const volunteer = this.store.getVolunteer(employeeId);
    if (!volunteer.active) throw new NotAllowedError(`${employeeId} is not an active volunteer.`);
    return volunteer;
  }

  #assertAdmin(refill, adminId) {
    if (this.#office(refill.officeId).adminId !== adminId) {
      throw new NotAllowedError('Only the office admin can do this.');
    }
  }
}

function unique(values) {
  return [...new Set(values)];
}
