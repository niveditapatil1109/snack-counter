import { ConcurrentUpdateError, NotFoundError } from '../domain/errors.js';
import { isOpen } from '../domain/refill.js';

/**
 * Storage for the exercise. Every method maps 1:1 to a simple SQL statement,
 * so swapping in Postgres later is mechanical:
 *
 *   saveRefill -> UPDATE refills SET ... WHERE id = $1 AND version = $2
 *                 (0 rows updated means someone else got there first)
 *   one open refill per office -> a partial unique index:
 *                 CREATE UNIQUE INDEX ON refills(office_id) WHERE state IN (open states)
 */
export class InMemoryStore {
  #refills = new Map();
  #volunteers = new Map();
  #nextRefillNumber = 1;

  constructor({ volunteers = [] } = {}) {
    for (const volunteer of volunteers) {
      this.#volunteers.set(volunteer.id, structuredClone(volunteer));
    }
  }

  // ---------- refills ----------

  nextRefillId() {
    return `R-${this.#nextRefillNumber++}`;
  }

  insertRefill(refill) {
    if (isOpen(refill) && this.findOpenRefill(refill.officeId)) {
      throw new ConcurrentUpdateError(`Office ${refill.officeId} already has an open refill`);
    }
    this.#refills.set(refill.id, refill);
    return refill;
  }

  getRefill(id) {
    const refill = this.#refills.get(id);
    if (!refill) throw new NotFoundError(`Refill ${id} not found`);
    return refill;
  }

  /**
   * Compare-and-set (optimistic locking). `updated` was built from a refill
   * at version N and now carries N + 1. The write only succeeds if the stored
   * refill is still at version N, meaning nobody changed it since we read it.
   */
  saveRefill(updated) {
    const stored = this.getRefill(updated.id);
    if (stored.version !== updated.version - 1) {
      throw new ConcurrentUpdateError(
        `Refill ${updated.id} was changed by someone else (stored v${stored.version}, ours based on v${updated.version - 1})`,
      );
    }
    this.#refills.set(updated.id, updated);
    return updated;
  }

  listRefills() {
    return [...this.#refills.values()];
  }

  findOpenRefill(officeId) {
    return this.listRefills().find((r) => r.officeId === officeId && isOpen(r)) ?? null;
  }

  // ---------- volunteers ----------

  listVolunteers() {
    return [...this.#volunteers.values()];
  }

  getVolunteer(id) {
    const volunteer = this.#volunteers.get(id);
    if (!volunteer) throw new NotFoundError(`Volunteer ${id} not found`);
    return volunteer;
  }

  saveVolunteer(volunteer) {
    this.#volunteers.set(volunteer.id, volunteer);
    return volunteer;
  }
}
