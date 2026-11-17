import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ValidationError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';
import { doRefill, setup } from './helpers.js';

const NOK = (n) => Money.of(n, 'NOK');
const INR = (n) => Money.of(n, 'INR');
const OPTIONS = { reportingCurrency: 'NOK', fxRates: { INR: 0.12 } };

async function novemberActivity() {
  const ctx = setup();
  await doRefill(ctx, 'OSL', NOK(1000), { ranOut: ['chips'] });
  ctx.clock.advanceHours(4);
  await doRefill(ctx, 'OSL', NOK(1150), { ranOut: ['chips', 'nuts'] });
  await doRefill(ctx, 'BLR', INR(2500), { ranOut: ['biscuits'] });
  return ctx;
}

describe('monthly report', () => {
  test('each office is reported in its own currency and the total in the reporting currency', async () => {
    const ctx = await novemberActivity();
    const report = ctx.app.reports.monthlyReport('2026-11', OPTIONS);
    const [oslo, blr] = report.offices;

    assert.ok(oslo.spent.equals(NOK(2150)));
    assert.equal(oslo.budgetUsedPercent, 36); // 2 150 / 6 000
    assert.ok(oslo.remaining.equals(NOK(3850)));
    assert.equal(oslo.refillCount, 2);
    assert.deepEqual(oslo.refillsByVolunteer, { anna: 1, bjorn: 1 });
    assert.deepEqual(oslo.mostRanOut, ['chips', 'nuts']);

    assert.ok(blr.spent.equals(INR(2500)));
    assert.ok(blr.spentInReportingCurrency.equals(NOK(300))); // 2 500 x 0.12
    assert.equal(blr.budgetUsedPercent, 17);

    assert.ok(report.total.equals(NOK(2450))); // 2 150 + 300
    assert.deepEqual(report.fxRates, { INR: 0.12 }); // rate snapshot kept with the report
  });

  test('the report works in any reporting currency', async () => {
    const ctx = await novemberActivity();
    const report = ctx.app.reports.monthlyReport('2026-11', { reportingCurrency: 'INR', fxRates: { NOK: 8 } });
    assert.ok(report.total.equals(INR(2150 * 8 + 2500)));
  });

  test('a missing exchange rate is an error, not a silently wrong total', async () => {
    const ctx = await novemberActivity();
    assert.throws(() => ctx.app.reports.monthlyReport('2026-11', { reportingCurrency: 'NOK', fxRates: {} }), ValidationError);
  });

  test('other months are not included', async () => {
    const ctx = await novemberActivity();
    const report = ctx.app.reports.monthlyReport('2026-12', OPTIONS);
    assert.ok(report.total.equals(NOK(0)));
  });

  test('the report is sent to management through chat', async () => {
    const ctx = await novemberActivity();
    await ctx.app.reports.sendMonthlyReport('management', '2026-11', OPTIONS);
    const text = ctx.chat.lastMessageTo('management');
    assert.match(text, /Oslo: 2150\.00 NOK of 6000\.00 NOK \(36%\)/);
    assert.match(text, /Bengaluru: 2500\.00 INR .* = 300\.00 NOK at 0\.12/);
    assert.match(text, /Total across offices: 2450\.00 NOK/);
  });
});
