/**
 * Simulated external HR system. It behaves like the real one where it
 * matters for our rules:
 *  - it can be down (failNextRequests),
 *  - it de-duplicates on the idempotency key,
 *  - approval happens later, outside our control (approve / reject).
 */
export class FakeHr {
  claims = new Map(); // claimId -> claim
  #claimIdByKey = new Map();
  #failuresLeft = 0;
  #nextNumber = 1;

  /** Make the next `count` calls fail, as if the vendor's API were down. */
  failNextRequests(count) {
    this.#failuresLeft = count;
  }

  async createClaim({ idempotencyKey, employeeId, amount, description, receiptImage }) {
    this.#maybeFail();
    if (!idempotencyKey || !employeeId || !amount || !description || !receiptImage) {
      throw new Error('HR rejected request: missing required field');
    }

    // Same key again (e.g. we retried after a timeout): return the existing claim.
    const existingId = this.#claimIdByKey.get(idempotencyKey);
    if (existingId) return { claimId: existingId };

    const claimId = `HR-${this.#nextNumber++}`;
    this.claims.set(claimId, { claimId, employeeId, amount, description, receiptImage, status: 'PENDING' });
    this.#claimIdByKey.set(idempotencyKey, claimId);
    return { claimId };
  }

  async getClaimStatus(claimId) {
    this.#maybeFail();
    return this.claims.get(claimId).status;
  }

  // ----- test controls: what HR staff would do in the real system -----

  approve(claimId) {
    this.claims.get(claimId).status = 'APPROVED';
  }

  reject(claimId) {
    this.claims.get(claimId).status = 'REJECTED';
  }

  #maybeFail() {
    if (this.#failuresLeft > 0) {
      this.#failuresLeft--;
      throw new Error('HR system unavailable (simulated)');
    }
  }
}
