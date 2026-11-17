import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Money } from '../src/domain/money.js';
import { RefillState as S } from '../src/domain/refill.js';
import { doRefill, setup } from './helpers.js';

describe('refill lifecycle: from "empty" to "reimbursed"', () => {
  test('happy path goes through every state and files a correct HR claim', async () => {
    const { app, chat, hr, clock, store } = setup();

    const reported = await app.refills.reportEmpty('OSL', 'someone', { ranOut: ['chips'] });
    assert.equal(reported.state, S.OFFERED);
    assert.equal(reported.assigneeId, 'anna');
    assert.match(chat.lastMessageTo('anna'), /you're up next.*up to 1200\.00 NOK/);

    await app.refills.acceptRefill(reported.id, 'anna');
    assert.match(chat.lastMessageTo('#snacks-OSL'), /Anna is refilling.*Nobody else needs to buy/);

    clock.advanceHours(3);
    const done = await app.refills.completeRefill(reported.id, 'anna', {
      amount: Money.of(950, 'NOK'),
      receiptImage: 'receipt-anna.jpg',
      items: ['chips', 'nuts'],
    });
    assert.equal(done.state, S.CLAIM_SUBMITTED);

    const claim = hr.claims.get(done.claim.hrClaimId);
    assert.equal(claim.employeeId, 'anna');
    assert.ok(claim.amount.equals(Money.of(950, 'NOK')));
    assert.equal(claim.receiptImage, 'receipt-anna.jpg');
    assert.match(claim.description, /R-1.*Oslo.*chips, nuts/);

    hr.approve(done.claim.hrClaimId);
    await app.runScheduledJobs();

    const final = store.getRefill(reported.id);
    assert.equal(final.state, S.REIMBURSED);
    assert.match(chat.lastMessageTo('anna'), /HR approved/);
    assert.deepEqual(
      final.history.map((h) => h.to),
      [S.REPORTED, S.OFFERED, S.COMMITTED, S.REFILLED, S.CLAIM_SUBMITTED, S.REIMBURSED],
    );
  });

  test('a second "empty" report joins the open refill instead of starting another', async () => {
    const { app, store } = setup();

    const first = await app.refills.reportEmpty('OSL', 'ola', { ranOut: ['chips'] });
    const second = await app.refills.reportEmpty('OSL', 'nora', { ranOut: ['biscuits'] });

    assert.equal(second.id, first.id);
    assert.equal(store.listRefills().length, 1);
    assert.deepEqual(second.reportedBy, ['ola', 'nora']);
    assert.deepEqual(second.ranOut, ['chips', 'biscuits']);
    assert.equal(second.assigneeId, 'anna'); // still the same single buyer
  });

  test('offices are independent: Oslo and Bengaluru can each have an open refill', async () => {
    const { app } = setup();
    const oslo = await app.refills.reportEmpty('OSL', 'x');
    const blr = await app.refills.reportEmpty('BLR', 'y');
    assert.notEqual(oslo.id, blr.id);
    assert.equal(blr.assigneeId, 'arjun');
  });

  test('once the box is refilled, a new empty report starts a new refill even while the claim is pending', async () => {
    const ctx = setup();
    const first = await doRefill(ctx, 'OSL', Money.of(800, 'NOK'));
    assert.equal(first.state, S.CLAIM_SUBMITTED);

    const next = await ctx.app.refills.reportEmpty('OSL', 'someone');
    assert.notEqual(next.id, first.id);
    assert.equal(next.assigneeId, 'bjorn'); // anna is still waiting for her money
  });

  test('the admin can cancel a false alarm, and the person asked is told not to buy', async () => {
    const { app, chat } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');

    const cancelled = await app.refills.cancelRefill(refill.id, 'osl-admin', 'box was not empty');
    assert.equal(cancelled.state, S.CANCELLED);
    assert.match(chat.lastMessageTo('anna'), /cancelled.*don't buy/);
    await assert.rejects(app.refills.cancelRefill(refill.id, 'osl-admin', 'again'));
  });
});
