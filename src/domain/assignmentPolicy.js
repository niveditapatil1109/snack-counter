import { isOpen, isUnpaid } from './refill.js';
import { addDays, localDate } from './time.js';

/**
 * "Who should buy this time?" A pure function: given the volunteers and the
 * refill history, it returns the fairest available person or null.
 * No database and no chat, so it is trivial to test and easy to change.
 */

/** Where a volunteer physically is on a date: a declared visit wins over home office. */
export function officeOn(volunteer, date) {
  const visit = volunteer.visits.find((v) => v.from <= date && date <= v.to);
  return visit ? visit.officeId : volunteer.homeOfficeId;
}

export function isAway(volunteer, date) {
  return volunteer.away.some((period) => period.from <= date && date <= period.to);
}

/** Who can be asked right now for this office. */
export function eligibleVolunteers({ office, volunteers, refills, triedIds, now }) {
  const today = localDate(now, office.timeZone);
  // Someone already asked or buying for another open refill is busy.
  const busyIds = new Set(refills.filter(isOpen).map((r) => r.assigneeId).filter(Boolean));

  return volunteers.filter(
    (v) =>
      v.active &&
      officeOn(v, today) === office.id && // physically at this office (home or visiting)
      !isAway(v, today) && //               not on holiday
      !triedIds.includes(v.id) && //        not already asked for this refill
      !busyIds.has(v.id),
  );
}

/** The numbers we rank on, per volunteer. Also useful to explain "why me?". */
export function fairnessStats(volunteerId, refills, now, fairnessWindowDays) {
  const windowStart = addDays(now, -fairnessWindowDays);
  const theirPurchases = refills.filter((r) => r.purchase?.buyerId === volunteerId);

  return {
    unpaidRefills: theirPurchases.filter(isUnpaid).length,
    recentRefills: theirPurchases.filter((r) => r.purchase.purchasedAt >= windowStart).length,
    lastRefillAt: Math.max(0, ...theirPurchases.map((r) => r.purchase.purchasedAt.getTime())),
  };
}

/**
 * Rank eligible volunteers, fairest first:
 *  1. fewest refills still waiting for reimbursement (don't make anyone front money twice)
 *  2. fewest refills in the fairness window (spread the work)
 *  3. longest since their last refill
 *  4. employee id, so the result is deterministic (same input, same answer)
 */
export function rankCandidates({ office, volunteers, refills, triedIds, now, rules }) {
  return eligibleVolunteers({ office, volunteers, refills, triedIds, now })
    .map((volunteer) => ({
      volunteer,
      stats: fairnessStats(volunteer.id, refills, now, rules.fairnessWindowDays),
    }))
    .sort(
      (a, b) =>
        a.stats.unpaidRefills - b.stats.unpaidRefills ||
        a.stats.recentRefills - b.stats.recentRefills ||
        a.stats.lastRefillAt - b.stats.lastRefillAt ||
        a.volunteer.id.localeCompare(b.volunteer.id),
    );
}

export function pickBuyer(input) {
  return rankCandidates(input)[0]?.volunteer ?? null;
}
