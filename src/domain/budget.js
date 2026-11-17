import { sum } from './money.js';
import { countsAsSpend } from './refill.js';
import { monthKey } from './time.js';

/**
 * Budget rules. A budget belongs to the snack COUNTER (office), in that
 * office's currency, never to the person buying. A Bengaluru employee who
 * refills the Oslo box spends Oslo's NOK budget.
 */

/** Total spent by an office in a month ('YYYY-MM', office timezone). */
export function spentInMonth(office, refills, month) {
  const amounts = refills
    .filter((r) => r.officeId === office.id && countsAsSpend(r))
    .filter((r) => monthKey(r.purchase.purchasedAt, office.timeZone) === month)
    .map((r) => r.purchase.amount);
  return sum(amounts, office.currency);
}

export function remainingBudget(office, refills, now) {
  const month = monthKey(now, office.timeZone);
  return office.monthlyBudget.minus(spentInMonth(office, refills, month));
}

/**
 * The budget check run before anyone is asked to buy.
 *
 * Because at most one refill per office is open at a time, the cap given to
 * the buyer acts as the reservation: nobody else can spend the same money in
 * parallel, so no separate reservation ledger is needed.
 */
export function checkBudget(office, refills, now) {
  const remaining = remainingBudget(office, refills, now);
  return {
    remaining,
    canAfford: !remaining.isLessThan(office.minPurchase),
    cap: office.maxPurchase.min(remaining),
  };
}
