import { FakeClock } from '../src/adapters/clock.js';
import { FakeChat } from '../src/adapters/fakeChat.js';
import { FakeHr } from '../src/adapters/fakeHr.js';
import { InMemoryStore } from '../src/adapters/inMemoryStore.js';
import { createApp } from '../src/app.js';
import { RULES } from '../src/config.js';

/** Tuesday 10 Nov 2026, 09:00 in Oslo. */
export const START = '2026-11-10T09:00:00+01:00';

export function volunteer(id, homeOfficeId, extra = {}) {
  return { id, name: id[0].toUpperCase() + id.slice(1), homeOfficeId, active: true, away: [], visits: [], ...extra };
}

/** With no history, ties break on id, so Oslo asks anna, bjorn, kari, lars in that order. */
export const DEFAULT_VOLUNTEERS = [
  volunteer('anna', 'OSL'),
  volunteer('bjorn', 'OSL'),
  volunteer('kari', 'OSL'),
  volunteer('lars', 'OSL'),
  volunteer('arjun', 'BLR'),
  volunteer('priya', 'BLR'),
  volunteer('ravi', 'BLR'),
];

/** A fresh app with fake chat, fake HR, an in-memory store and a controllable clock. */
export function setup({ volunteers = DEFAULT_VOLUNTEERS, rules = {}, start = START } = {}) {
  const clock = new FakeClock(start);
  const chat = new FakeChat();
  const hr = new FakeHr();
  const store = new InMemoryStore({ volunteers });
  const app = createApp({ store, chat, hr, clock, rules: { ...RULES, ...rules } });
  return { app, clock, chat, hr, store };
}

/** Report empty, let the chosen volunteer accept, and upload a receipt. */
export async function doRefill({ app }, officeId, amount, { ranOut = [] } = {}) {
  const reported = await app.refills.reportEmpty(officeId, 'reporter', { ranOut });
  const buyerId = reported.assigneeId;
  await app.refills.acceptRefill(reported.id, buyerId);
  return app.refills.completeRefill(reported.id, buyerId, { amount, receiptImage: 'receipt.jpg' });
}
