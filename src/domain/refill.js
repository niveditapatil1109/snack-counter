import { InvalidTransitionError } from './errors.js';

/**
 * A Refill is one trip from "the box is empty" to "the buyer got their money
 * back". This file is the state machine. It is pure (no I/O): it only knows
 * which moves are legal and how to record them.
 */
export const RefillState = Object.freeze({
  REPORTED: 'REPORTED', //               someone said the box is empty
  OFFERED: 'OFFERED', //                 one named volunteer has been asked
  COMMITTED: 'COMMITTED', //             that volunteer said yes and is buying
  ESCALATED: 'ESCALATED', //             nobody took it; open to anyone + admin pinged
  BLOCKED_BUDGET: 'BLOCKED_BUDGET', //   not enough budget left; admin must approve
  REFILLED: 'REFILLED', //               receipt uploaded, box is full, claim not filed yet
  CLAIM_SUBMITTED: 'CLAIM_SUBMITTED', // HR has the claim
  REIMBURSED: 'REIMBURSED', //           HR approved, buyer gets paid
  CLAIM_REJECTED: 'CLAIM_REJECTED', //   HR said no; admin follows up by hand
  CANCELLED: 'CANCELLED', //             false alarm
});

const S = RefillState;

/**
 * Every legal move. Anything not listed here throws InvalidTransitionError,
 * so a bug can never, for example, reimburse a refill nobody bought.
 * Staying in the same state is always allowed (used to record a note, such
 * as an offer passing to the next person or a failed HR submission).
 */
const ALLOWED_TRANSITIONS = {
  [S.REPORTED]: [S.OFFERED, S.ESCALATED, S.BLOCKED_BUDGET, S.CANCELLED],
  [S.OFFERED]: [S.COMMITTED, S.ESCALATED, S.BLOCKED_BUDGET, S.CANCELLED],
  [S.COMMITTED]: [S.REFILLED, S.OFFERED, S.ESCALATED, S.BLOCKED_BUDGET, S.CANCELLED],
  [S.ESCALATED]: [S.COMMITTED, S.CANCELLED],
  [S.BLOCKED_BUDGET]: [S.OFFERED, S.ESCALATED, S.CANCELLED],
  [S.REFILLED]: [S.CLAIM_SUBMITTED],
  [S.CLAIM_SUBMITTED]: [S.REIMBURSED, S.CLAIM_REJECTED],
  [S.REIMBURSED]: [],
  [S.CLAIM_REJECTED]: [],
  [S.CANCELLED]: [],
};

/** The box is still empty: at most ONE refill per office may be in these states. */
const OPEN_STATES = new Set([S.REPORTED, S.OFFERED, S.COMMITTED, S.ESCALATED, S.BLOCKED_BUDGET]);

/** The purchase counts as company spend (a rejected claim is not paid by the company). */
const SPEND_STATES = new Set([S.REFILLED, S.CLAIM_SUBMITTED, S.REIMBURSED]);

/** The buyer has paid out of pocket and is still waiting for the money. */
const UNPAID_STATES = new Set([S.REFILLED, S.CLAIM_SUBMITTED]);

export const isOpen = (refill) => OPEN_STATES.has(refill.state);
export const countsAsSpend = (refill) => SPEND_STATES.has(refill.state);
export const isUnpaid = (refill) => UNPAID_STATES.has(refill.state);

export function createRefill({ id, officeId, reportedBy, ranOut = [], now }) {
  return {
    id,
    officeId,
    state: S.REPORTED,
    version: 1, //            bumped on every change; used for optimistic locking
    reportedAt: now,
    reportedBy: [reportedBy],
    ranOut: [...ranOut], //   "what ran out first", a cheap signal of what gets eaten
    assigneeId: null, //      who is currently asked / buying
    triedIds: [], //          who was already asked for THIS refill (never asked twice)
    cap: null, //             spending limit (Money) told to the buyer
    offerExpiresAt: null,
    purchaseDueAt: null,
    budgetOverride: false, // admin approved going over budget
    purchase: null, //        { buyerId, amount, receiptImage, items, purchasedAt, overCap }
    claim: null, //           { hrClaimId, attempts, lastError, submittedAt, decidedAt, nudgedAt }
    history: [{ at: now, from: null, to: S.REPORTED, by: reportedBy, note: 'Box reported empty' }],
  };
}

/**
 * Return a NEW refill moved to state `to`. The old object is not modified.
 * Also bumps the version and appends to the audit history.
 */
export function transition(refill, to, { at, by = 'system', note = '', changes = {} }) {
  const sameState = to === refill.state;
  if (!sameState && !ALLOWED_TRANSITIONS[refill.state].includes(to)) {
    throw new InvalidTransitionError(refill.state, to);
  }
  return {
    ...refill,
    ...changes,
    state: to,
    version: refill.version + 1,
    history: [...refill.history, { at, from: refill.state, to, by, note }],
  };
}
