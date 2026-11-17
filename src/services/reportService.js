import { spentInMonth } from '../domain/budget.js';
import { ValidationError } from '../domain/errors.js';
import { sum } from '../domain/money.js';
import { countsAsSpend, RefillState as S } from '../domain/refill.js';
import { hoursBetween, monthKey } from '../domain/time.js';

/**
 * The monthly management report. Each office is reported in its own
 * currency (the true numbers), plus ONE combined total in a reporting
 * currency. The exchange rates used are stored in the report, so the same
 * report can be reproduced later with the same numbers.
 */
export class ReportService {
  constructor({ store, chat, offices }) {
    this.store = store;
    this.chat = chat;
    this.offices = offices;
  }

  /**
   * @param {string} month 'YYYY-MM'. A purchase belongs to the month it was
   *   made in, in the office's timezone (not when HR approved it).
   * @param {{ reportingCurrency: string, fxRates: Record<string, number> }} options
   *   fxRates: 1 unit of each office currency = N units of the reporting currency,
   *   e.g. { INR: 0.13 } when reporting in NOK.
   */
  monthlyReport(month, { reportingCurrency, fxRates }) {
    const refills = this.store.listRefills();

    const offices = Object.values(this.offices).map((office) => {
      const rate = office.currency === reportingCurrency ? 1 : fxRates[office.currency];
      if (rate === undefined) {
        throw new ValidationError(`Missing ${office.currency} to ${reportingCurrency} rate for ${month}`);
      }

      const inMonth = refills.filter(
        (r) => r.officeId === office.id && r.purchase && monthKey(r.purchase.purchasedAt, office.timeZone) === month,
      );
      const paidFor = inMonth.filter(countsAsSpend);
      const spent = spentInMonth(office, refills, month);

      return {
        officeId: office.id,
        officeName: office.name,
        budget: office.monthlyBudget,
        spent,
        remaining: office.monthlyBudget.minus(spent),
        budgetUsedPercent: Math.round((spent.minor / office.monthlyBudget.minor) * 100),
        fxRate: rate,
        spentInReportingCurrency: spent.convertTo(reportingCurrency, rate), // convert once, round once
        refillCount: paidFor.length,
        averageHoursEmpty: round1(average(paidFor.map((r) => hoursBetween(r.reportedAt, r.purchase.purchasedAt)))),
        overCapCount: paidFor.filter((r) => r.purchase.overCap).length,
        awaitingReimbursement: paidFor.filter((r) => r.state !== S.REIMBURSED).length,
        rejectedClaims: inMonth.filter((r) => r.state === S.CLAIM_REJECTED).length,
        refillsByVolunteer: countBy(paidFor.map((r) => r.purchase.buyerId)),
        mostRanOut: topN(paidFor.flatMap((r) => r.ranOut), 3),
      };
    });

    return {
      month,
      reportingCurrency,
      fxRates: { ...fxRates },
      offices,
      total: sum(
        offices.map((o) => o.spentInReportingCurrency),
        reportingCurrency,
      ),
    };
  }

  /** Build the report and send it to management through the chat tool. */
  async sendMonthlyReport(recipientId, month, options) {
    const report = this.monthlyReport(month, options);
    await this.chat.sendDirect(recipientId, formatReport(report));
    return report;
  }
}

/** Plain-text version for chat. */
export function formatReport(report) {
  const lines = [`Snack spending report for ${report.month}`];
  for (const o of report.offices) {
    const rate = o.fxRate === 1 ? '' : ` = ${o.spentInReportingCurrency} at ${o.fxRate}`;
    lines.push(
      `- ${o.officeName}: ${o.spent} of ${o.budget} (${o.budgetUsedPercent}%)${rate}`,
      `    ${o.refillCount} refill(s), box empty ${o.averageHoursEmpty} h on average, ` +
        `${o.awaitingReimbursement} awaiting reimbursement, ${o.overCapCount} over cap` +
        (o.mostRanOut.length ? `, ran out first: ${o.mostRanOut.join(', ')}` : ''),
    );
  }
  lines.push(`Total across offices: ${report.total}`);
  return lines.join('\n');
}

function average(numbers) {
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function topN(values, n) {
  return Object.entries(countBy(values))
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .slice(0, n)
    .map(([value]) => value);
}
