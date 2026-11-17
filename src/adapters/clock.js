import { addHours } from '../domain/time.js';

/** The real clock, for production. */
export const systemClock = {
  now: () => new Date(),
};

/** A clock tests can move forward by hand, so "wait 2 hours" takes 0 ms. */
export class FakeClock {
  #now;

  constructor(start) {
    this.#now = new Date(start);
  }

  now() {
    return new Date(this.#now);
  }

  advanceHours(hours) {
    this.#now = addHours(this.#now, hours);
  }

  set(date) {
    this.#now = new Date(date);
  }
}
