import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Money } from '../src/domain/money.js';
import { RefillState as S } from '../src/domain/refill.js';
import { doRefill, setup } from './helpers.js';

const NOK = (n) => Money.of(n, 'NOK');

describe('reimbursement claims', () => {
  test('if HR is down, the receipt is kept and the claim is retried until it goes through, exactly once', async () => {
    const ctx = setup();
    ctx.hr.failNextRequests(2);

    const done = await doRefill(ctx, 'OSL', NOK(800));
    assert.equal(done.state, S.REFILLED); // box is full; claim not filed yet
    assert.match(done.claim.lastError, /unavailable/);

    await ctx.app.runScheduledJobs(); // attempt 2 fails
    await ctx.app.runScheduledJobs(); // attempt 3 works

    const refill = ctx.store.getRefill(done.id);
    assert.equal(refill.state, S.CLAIM_SUBMITTED);
    assert.equal(refill.claim.attempts, 3);
    assert.equal(ctx.hr.claims.size, 1);
  });

  test('submitting the same refill twice never creates two HR claims (idempotency key)', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(800));
    await ctx.app.claims.submit(done);
    await ctx.app.claims.submit(done);
    assert.equal(ctx.hr.claims.size, 1);
  });

  test('after the maximum attempts, retries stop and the admin is asked to file it by hand', async () => {
    const ctx = setup({ rules: { hrMaxAttempts: 2 } });
    ctx.hr.failNextRequests(10);

    const done = await doRefill(ctx, 'OSL', NOK(800)); // attempt 1
    await ctx.app.runScheduledJobs(); // attempt 2, the last one
    await ctx.app.runScheduledJobs(); // no more attempts

    assert.equal(ctx.store.getRefill(done.id).claim.attempts, 2);
    assert.match(ctx.chat.lastMessageTo('osl-admin'), /after 2 attempts.*file it by hand/);
  });

  test('a rejected claim is reported to the buyer and the admin', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(800));
    ctx.hr.reject(done.claim.hrClaimId);
    await ctx.app.runScheduledJobs();

    assert.equal(ctx.store.getRefill(done.id).state, S.CLAIM_REJECTED);
    assert.match(ctx.chat.lastMessageTo('anna'), /rejected/);
    assert.match(ctx.chat.lastMessageTo('osl-admin'), /rejected.*follow up/);
  });

  test('a claim still pending after 10 days triggers one nudge to the admin', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(800));

    ctx.clock.advanceHours(24 * 9);
    await ctx.app.runScheduledJobs();
    assert.equal(ctx.chat.messagesTo('osl-admin').length, 0);

    ctx.clock.advanceHours(24 * 2);
    await ctx.app.runScheduledJobs();
    await ctx.app.runScheduledJobs();
    assert.equal(ctx.chat.messagesTo('osl-admin').length, 1);
    assert.match(ctx.chat.lastMessageTo('osl-admin'), /more than 10 days/);
    assert.equal(ctx.store.getRefill(done.id).state, S.CLAIM_SUBMITTED);
  });

  test('HR being down while checking status changes nothing; it is checked again next time', async () => {
    const ctx = setup();
    const done = await doRefill(ctx, 'OSL', NOK(800));
    ctx.hr.approve(done.claim.hrClaimId);

    ctx.hr.failNextRequests(1);
    await ctx.app.runScheduledJobs();
    assert.equal(ctx.store.getRefill(done.id).state, S.CLAIM_SUBMITTED);

    await ctx.app.runScheduledJobs();
    assert.equal(ctx.store.getRefill(done.id).state, S.REIMBURSED);
  });
});
