import { Money } from './domain/money.js';

/**
 * Offices are configuration, not code: adding a third office is one more
 * entry here.
 */
export const OFFICES = {
  OSL: {
    id: 'OSL',
    name: 'Oslo',
    currency: 'NOK',
    timeZone: 'Europe/Oslo',
    monthlyBudget: Money.of(6000, 'NOK'),
    minPurchase: Money.of(300, 'NOK'), //   below this, a trip to the shop is not worth it
    maxPurchase: Money.of(1200, 'NOK'), //  upper end of a typical purchase
    adminId: 'osl-admin',
  },
  BLR: {
    id: 'BLR',
    name: 'Bengaluru',
    currency: 'INR',
    timeZone: 'Asia/Kolkata',
    monthlyBudget: Money.of(15000, 'INR'),
    minPurchase: Money.of(500, 'INR'),
    maxPurchase: Money.of(3000, 'INR'),
    adminId: 'blr-admin',
  },
};

/** Timing and fairness rules. One place to tune behaviour. */
export const RULES = {
  offerTimeoutHours: 2, //       no answer to an offer in 2 h: ask the next person
  purchaseTimeoutHours: 24, //   said yes but no receipt in 24 h: hand it to someone else
  maxDirectOffers: 3, //         after 3 people, open it to everyone and ping the admin
  fairnessWindowDays: 90, //     "recent refills" look back this far
  overCapTolerance: 0.1, //      up to 10% over the cap is fine; above that the admin is told
  claimNudgeAfterDays: 10, //    HR says 1-10 days; after that, nudge the admin
  hrMaxAttempts: 5, //           give up auto-retrying the HR call after this; admin is told
};

/** Who receives the combined monthly report. */
export const MANAGEMENT_ID = 'management';
