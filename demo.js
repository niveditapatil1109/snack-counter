/**
 * A narrated run-through of one week, using the same fakes as the tests.
 * Run with: npm run demo
 */
import { FakeClock } from './src/adapters/clock.js';
import { FakeChat } from './src/adapters/fakeChat.js';
import { FakeHr } from './src/adapters/fakeHr.js';
import { InMemoryStore } from './src/adapters/inMemoryStore.js';
import { createApp } from './src/app.js';
import { MANAGEMENT_ID } from './src/config.js';
import { Money } from './src/domain/money.js';

const person = (id, name, homeOfficeId) => ({ id, name, homeOfficeId, active: true, away: [], visits: [] });

const clock = new FakeClock('2026-11-10T09:00:00+01:00');
const chat = new FakeChat({ onMessage: ({ to, text }) => console.log(`    [chat -> ${to}] ${text}`) });
const hr = new FakeHr();
const store = new InMemoryStore({
  volunteers: [
    person('anna', 'Anna', 'OSL'),
    person('bjorn', 'Bjørn', 'OSL'),
    person('kari', 'Kari', 'OSL'),
    person('arjun', 'Arjun', 'BLR'),
    person('priya', 'Priya', 'BLR'),
  ],
});
const app = createApp({ store, chat, hr, clock });

const step = (text) => console.log(`\n${clock.now().toISOString().slice(0, 16)}Z  ${text}`);

step('Ola reports the Oslo box empty (chips ran out first)');
const refill = await app.refills.reportEmpty('OSL', 'ola', { ranOut: ['chips'] });

clock.advanceHours(2.5);
step('Anna has not answered. 2.5 hours later the scheduler runs');
await app.runScheduledJobs();

step('Bjørn is working from home today and taps Decline');
await app.refills.declineRefill(refill.id, 'bjorn');

step('Kari accepts');
await app.refills.acceptRefill(refill.id, 'kari');

step('Nora also notices the empty box and reports it');
await app.refills.reportEmpty('OSL', 'nora', { ranOut: ['biscuits'] });

clock.advanceHours(3);
step('Kari buys snacks and uploads the receipt');
await app.refills.completeRefill(refill.id, 'kari', {
  amount: Money.of(950, 'NOK'),
  receiptImage: 'kari-receipt.jpg',
  items: ['chips', 'biscuits', 'fruit'],
});

step('Meanwhile in Bengaluru: Priya reports empty. Arjun accepts and buys, but HR is down (claim not filed yet)');
hr.failNextRequests(1);
const blr = await app.refills.reportEmpty('BLR', 'priya', { ranOut: ['namkeen'] });
await app.refills.acceptRefill(blr.id, blr.assigneeId);
await app.refills.completeRefill(blr.id, blr.assigneeId, { amount: Money.of(2400, 'INR'), receiptImage: 'arjun.jpg' });

clock.advanceHours(0.25);
step('Scheduler runs: the failed claim is retried');
await app.runScheduledJobs();

clock.advanceHours(72);
step('Three days later HR approves both claims');
for (const id of hr.claims.keys()) hr.approve(id);
await app.runScheduledJobs();

step('End of month: report to management (reporting currency NOK, 1 INR = 0.12 NOK)');
await app.reports.sendMonthlyReport(MANAGEMENT_ID, '2026-11', { reportingCurrency: 'NOK', fxRates: { INR: 0.12 } });

console.log(`\nAudit trail for ${refill.id}:`);
for (const h of store.getRefill(refill.id).history) {
  console.log(`  ${h.at.toISOString().slice(0, 16)}Z  ${(h.from ?? '-').padEnd(15)} -> ${h.to.padEnd(15)} ${h.note}`);
}
