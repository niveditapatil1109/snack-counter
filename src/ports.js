/**
 * PORTS: the contracts between the core logic and the outside world.
 *
 * The services only ever call these methods. Tests plug in fakes
 * (src/adapters/fake*.js). Production would plug in a Slack/Teams client,
 * the HR vendor's REST client and a Postgres store, with no change to the
 * core logic. This file holds no code, only the agreed shapes.
 *
 * @typedef {Object} ChatPort
 * @property {(employeeId: string, text: string) => Promise<void>} sendDirect
 *     Private message to one person (offers, reminders, receipts).
 * @property {(officeId: string, text: string) => Promise<void>} postToChannel
 *     Message to the office's #snacks channel (box empty / box full / help wanted).
 *
 * @typedef {Object} HrPort
 * @property {(claim: {
 *     idempotencyKey: string,
 *     employeeId: string,
 *     amount: import('./domain/money.js').Money,
 *     description: string,
 *     receiptImage: string,
 *   }) => Promise<{ claimId: string }>} createClaim
 *     Create a reimbursement claim. Sending the same idempotencyKey twice
 *     must return the same claim and never create a second one.
 * @property {(claimId: string) => Promise<'PENDING'|'APPROVED'|'REJECTED'>} getClaimStatus
 *
 * @typedef {Object} Clock
 * @property {() => Date} now
 *     Injected so tests can "fast-forward time" instead of waiting.
 */

export {};
