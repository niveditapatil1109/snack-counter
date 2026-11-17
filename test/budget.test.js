import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OFFICES } from '../src/config.js';
import { remainingBudget, spentInMonth } from '../src/domain/budget.js';
import { NotAllowedError, ValidationError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';
import { RefillState as S } from '../src/domain/refill.js';
import { doRefill, setup } from './helpers.js';

const NOK = (n) => Money.of(n, 'NOK');
const INR = (n) => Money.of(n, 'INR');

describe('budget check', () => {
  test('the buyer is told the typical maximum when plenty of budget is left', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('BLR', 'someone');
    assert.ok(refill.cap.equals(INR(3000)));
  });

  test('the cap shrinks to whatever is left of the monthly budget', async () => {
    const ctx = setup();
    for (let i = 0; i < 4; i++) await doRefill(ctx, 'OSL', NOK(1300)); // 5 200 of 6 000 spent

    const refill = await ctx.app.refills.reportEmpty('OSL', 'someone');
    assert.ok(refill.cap.equals(NOK(800)));
    assert.match(ctx.chat.lastMessageTo(refill.assigneeId), /up to 800\.00 NOK/);
  });

  test('when less than a useful purchase is left, nobody is asked and the admin decides', async () => {
    const ctx = setup();
    for (let i = 0; i < 4; i++) await doRefill(ctx, 'OSL', NOK(1300));
    await doRefill(ctx, 'OSL', NOK(600)); // 5 800 spent, 200 left < 300 minimum

    const blocked = await ctx.app.refills.reportEmpty('OSL', 'someone');
    assert.equal(blocked.state, S.BLOCKED_BUDGET);
    assert.equal(blocked.assigneeId, null);
    assert.match(ctx.chat.lastMessageTo('osl-admin'), /only 200\.00 NOK of the monthly budget is left/);

    await assert.rejects(ctx.app.refills.approveOverBudget(blocked.id, 'anna'), NotAllowedError);
    const approved = await ctx.app.refills.approveOverBudget(blocked.id, 'osl-admin');
    assert.equal(approved.state, S.OFFERED);
    assert.ok(approved.cap.equals(NOK(1200)));
  });

  test('spending over the cap is flagged to the admin but the claim is still filed', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(1500)); // cap 1 200 + 10% tolerance = 1 320
    assert.equal(done.purchase.overCap, true);
    assert.equal(done.state, S.CLAIM_SUBMITTED);
    assert.match(ctx.chat.lastMessageTo('osl-admin'), /above the cap/);

    const withinTolerance = await doRefill(ctx, 'OSL', NOK(1300));
    assert.equal(withinTolerance.purchase.overCap, false);
  });

  test('a receipt in the wrong currency for the counter is refused', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.acceptRefill(refill.id, 'anna');
    await assert.rejects(
      app.refills.completeRefill(refill.id, 'anna', { amount: INR(500), receiptImage: 'r.jpg' }),
      ValidationError,
    );
  });
});

describe('budgets and totals across both currencies', () => {
  test('a Bengaluru visitor refilling Oslo spends Oslo NOK budget and is reimbursed for the NOK receipt', async () => {
    const ctx = setup();
    ctx.app.volunteers.declareVisit('arjun', 'OSL', '2026-11-09', '2026-11-20');
    // Everyone from Oslo is away, so the visitor is chosen.
    for (const id of ['anna', 'bjorn', 'kari', 'lars']) ctx.app.volunteers.markAway(id, '2026-11-10', '2026-11-10');

    const done = await doRefill(ctx, 'OSL', NOK(700));
    assert.equal(done.purchase.buyerId, 'arjun');

    const claim = ctx.hr.claims.get(done.claim.hrClaimId);
    assert.equal(claim.employeeId, 'arjun');
    assert.ok(claim.amount.equals(NOK(700))); // HR converts to his INR payroll, not us

    const now = ctx.clock.now();
    const refills = ctx.store.listRefills();
    assert.ok(remainingBudget(OFFICES.OSL, refills, now).equals(NOK(5300)));
    assert.ok(remainingBudget(OFFICES.BLR, refills, now).equals(INR(15000)));
  });

  test('a rejected claim does not count as company spend', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(900));
    ctx.hr.reject(done.claim.hrClaimId);
    await ctx.app.runScheduledJobs();

    assert.ok(spentInMonth(OFFICES.OSL, ctx.store.listRefills(), '2026-11').equals(NOK(0)));
  });

  test('spend lands in the month of the office timezone, not UTC', async () => {
    // 1 Dec 00:30 in Bengaluru is still 30 Nov in UTC.
    const ctx = setup({ start: '2026-11-30T23:00:00+05:30' });
    const refill = await ctx.app.refills.reportEmpty('BLR', 'someone');
    await ctx.app.refills.acceptRefill(refill.id, refill.assigneeId);
    ctx.clock.set('2026-12-01T00:30:00+05:30');
    await ctx.app.refills.completeRefill(refill.id, refill.assigneeId, { amount: INR(1000), receiptImage: 'r.jpg' });

    const refills = ctx.store.listRefills();
    assert.ok(spentInMonth(OFFICES.BLR, refills, '2026-12').equals(INR(1000)));
    assert.ok(spentInMonth(OFFICES.BLR, refills, '2026-11').equals(INR(0)));
  });
});
