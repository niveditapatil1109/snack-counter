import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NotAllowedError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';
import { RefillState as S } from '../src/domain/refill.js';
import { DEFAULT_VOLUNTEERS, setup } from './helpers.js';

describe('a refill nobody completes is handed to someone else', () => {
  test('an unanswered offer moves to the next person after the timeout, not before', async () => {
    const { app, clock, store, chat } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');

    clock.advanceHours(1);
    await app.runScheduledJobs();
    assert.equal(store.getRefill(refill.id).assigneeId, 'anna'); // still within 2 h

    clock.advanceHours(1.5);
    await app.runScheduledJobs();
    const moved = store.getRefill(refill.id);
    assert.equal(moved.assigneeId, 'bjorn');
    assert.deepEqual(moved.triedIds, ['anna']);
    assert.match(chat.lastMessageTo('anna'), /went to someone else/);
    assert.match(chat.lastMessageTo('bjorn'), /you're up next/);
  });

  test('a decline passes the refill on immediately', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    const next = await app.refills.declineRefill(refill.id, 'anna');
    assert.equal(next.assigneeId, 'bjorn');
  });

  test('someone who said yes but never bought is released and the next person is asked', async () => {
    const { app, clock, store, chat } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.acceptRefill(refill.id, 'anna');

    clock.advanceHours(25);
    await app.runScheduledJobs();

    const moved = store.getRefill(refill.id);
    assert.equal(moved.state, S.OFFERED);
    assert.equal(moved.assigneeId, 'bjorn');
    assert.match(chat.lastMessageTo('anna'), /Please do NOT buy/);

    // The released buyer can no longer complete it, so two purchases cannot both be reimbursed through the bot.
    await assert.rejects(
      app.refills.completeRefill(refill.id, 'anna', { amount: Money.of(500, 'NOK'), receiptImage: 'r.jpg' }),
      NotAllowedError,
    );
  });

  test('the same person is never asked twice for one refill', async () => {
    const { app, store } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.declineRefill(refill.id, 'anna');
    await app.refills.declineRefill(refill.id, 'bjorn');

    const current = store.getRefill(refill.id);
    assert.equal(current.assigneeId, 'kari');
    assert.deepEqual(current.triedIds, ['anna', 'bjorn']);
  });

  test('after three people pass, the refill is opened to everyone and the admin is pinged', async () => {
    const { app, chat, store } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.declineRefill(refill.id, 'anna');
    await app.refills.declineRefill(refill.id, 'bjorn');
    await app.refills.declineRefill(refill.id, 'kari');

    assert.equal(store.getRefill(refill.id).state, S.ESCALATED);
    assert.match(chat.lastMessageTo('#snacks-OSL'), /Help wanted.*first volunteer to accept/);
    assert.match(chat.lastMessageTo('osl-admin'), /no volunteer after 3 offer/);

    // Anyone can now take it, even someone who declined earlier.
    const taken = await app.refills.acceptRefill(refill.id, 'bjorn');
    assert.equal(taken.assigneeId, 'bjorn');
  });

  test('if nobody is available at all (everyone on holiday), it escalates straight away', async () => {
    const onHoliday = DEFAULT_VOLUNTEERS.map((v) => ({ ...v, away: [{ from: '2026-11-01', to: '2026-11-30' }] }));
    const { app, chat } = setup({ volunteers: onHoliday });

    const refill = await app.refills.reportEmpty('OSL', 'someone');
    assert.equal(refill.state, S.ESCALATED);
    assert.match(chat.lastMessageTo('osl-admin'), /no volunteer after 0 offer/);
  });

  test('a volunteer who declares a holiday through the bot is skipped', async () => {
    const { app } = setup();
    app.volunteers.markAway('anna', '2026-11-10', '2026-11-14');
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    assert.equal(refill.assigneeId, 'bjorn');
  });

  test('running the scheduler twice in a row does not skip anyone', async () => {
    const { app, clock, store } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    clock.advanceHours(3);
    await app.runScheduledJobs();
    await app.runScheduledJobs(); // bjorn's offer is brand new, so it must not expire

    assert.equal(store.getRefill(refill.id).assigneeId, 'bjorn');
  });
});
