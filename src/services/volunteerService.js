import { NotFoundError, ValidationError } from '../domain/errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Availability. Volunteers tell the bot when they are on holiday or visiting
 * the other office. Dates are office-local 'YYYY-MM-DD', inclusive.
 *
 * Working from home is deliberately NOT tracked: asking 35 people to check in
 * every day would not happen. If someone is offered a refill on a WFH day,
 * "Decline" is one tap and the next person is asked straight away.
 */
export class VolunteerService {
  constructor({ store, offices }) {
    this.store = store;
    this.offices = offices;
  }

  markAway(employeeId, from, to) {
    assertPeriod(from, to);
    const volunteer = this.store.getVolunteer(employeeId);
    return this.store.saveVolunteer({ ...volunteer, away: [...volunteer.away, { from, to }] });
  }

  /** Visitors join the host office's rotation and leave their home one for those dates. */
  declareVisit(employeeId, officeId, from, to) {
    assertPeriod(from, to);
    if (!this.offices[officeId]) throw new NotFoundError(`Unknown office ${officeId}`);
    const volunteer = this.store.getVolunteer(employeeId);
    return this.store.saveVolunteer({ ...volunteer, visits: [...volunteer.visits, { officeId, from, to }] });
  }
}

function assertPeriod(from, to) {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new ValidationError(`Invalid period ${from}..${to}; use YYYY-MM-DD with from <= to`);
  }
}
