import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConcurrentUpdateError, NotAllowedError, RefillUnavailableError } from '../src/domain/errors.js';
import { Money } from '../src/domain/money.js';
import { RefillState as S, transition } from '../src/domain/refill.js';
import { setup } from './helpers.js';

describe('two people cannot both commit to the same refill', () => {
  test('only the person who was offered the refill can accept it', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone'); // offered to anna

    await assert.rejects(app.refills.acceptRefill(refill.id, 'bjorn'), NotAllowedError);
    const committed = await app.refills.acceptRefill(refill.id, 'anna');
    assert.equal(committed.state, S.COMMITTED);
  });

  test('when a refill is open to everyone, two simultaneous accepts produce exactly one buyer', async () => {
    const { app, store } = setup({ rules: { maxDirectOffers: 0 } }); // skip straight to "open to everyone"
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    assert.equal(refill.state, S.ESCALATED);

    const results = await Promise.allSettled([
      app.refills.acceptRefill(refill.id, 'kari'),
      app.refills.acceptRefill(refill.id, 'lars'),
    ]);

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0].reason instanceof RefillUnavailableError);
    assert.equal(store.getRefill(refill.id).assigneeId, 'kari');
  });

  test('accepting after the offer has moved on to someone else is refused', async () => {
    const { app, clock } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone'); // anna

    clock.advanceHours(3);
    await app.runScheduledJobs(); // anna timed out, bjorn is asked

    await assert.rejects(app.refills.acceptRefill(refill.id, 'anna'), NotAllowedError);
  });

  test('accepting twice does not reset the purchase deadline', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.acceptRefill(refill.id, 'anna');
    await assert.rejects(app.refills.acceptRefill(refill.id, 'anna'), RefillUnavailableError);
  });

  test('the store rejects a write based on an out-of-date read (optimistic lock, multi-server safety)', async () => {
    const { app, store, clock } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');

    // Two servers read the same version and both try to commit it.
    const serverA = store.getRefill(refill.id);
    const serverB = store.getRefill(refill.id);
    store.saveRefill(transition(serverA, S.COMMITTED, { at: clock.now(), by: 'anna' }));

    assert.throws(
      () => store.saveRefill(transition(serverB, S.COMMITTED, { at: clock.now(), by: 'anna' })),
      ConcurrentUpdateError,
    );
  });

  test('only the committed buyer can upload the receipt', async () => {
    const { app } = setup();
    const refill = await app.refills.reportEmpty('OSL', 'someone');
    await app.refills.acceptRefill(refill.id, 'anna');

    await assert.rejects(
      app.refills.completeRefill(refill.id, 'bjorn', { amount: Money.of(500, 'NOK'), receiptImage: 'r.jpg' }),
      NotAllowedError,
    );
  });
});
