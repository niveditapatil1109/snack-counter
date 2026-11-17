import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OFFICES, RULES } from '../src/config.js';
import { pickBuyer, rankCandidates } from '../src/domain/assignmentPolicy.js';
import { Money } from '../src/domain/money.js';
import { RefillState as S } from '../src/domain/refill.js';
import { volunteer } from './helpers.js';

// Pure-function tests: no services, no fakes, just data in and a person out.

const NOW = new Date('2026-11-10T09:00:00+01:00'); // 2026-11-10 in Oslo
const oslo = OFFICES.OSL;

function pastRefill(buyerId, purchasedAt, state = S.REIMBURSED) {
  return {
    officeId: 'OSL',
    state,
    assigneeId: buyerId,
    purchase: { buyerId, purchasedAt: new Date(purchasedAt), amount: Money.of(500, 'NOK') },
  };
}

function pick(volunteers, refills = [], triedIds = []) {
  return pickBuyer({ office: oslo, volunteers, refills, triedIds, now: NOW, rules: RULES })?.id ?? null;
}

describe('choosing who buys', () => {
  test('the volunteer with the fewest recent refills is chosen', () => {
    const volunteers = [volunteer('anna', 'OSL'), volunteer('bjorn', 'OSL')];
    const refills = [pastRefill('anna', '2026-10-01'), pastRefill('anna', '2026-10-15'), pastRefill('bjorn', '2026-10-20')];
    assert.equal(pick(volunteers, refills), 'bjorn');
  });

  test('someone still waiting to be reimbursed is asked last, even if they did fewer refills', () => {
    const volunteers = [volunteer('anna', 'OSL'), volunteer('bjorn', 'OSL')];
    const refills = [
      pastRefill('anna', '2026-09-01'),
      pastRefill('anna', '2026-10-01'),
      pastRefill('bjorn', '2026-11-05', S.CLAIM_SUBMITTED), // bjorn has not been paid back yet
    ];
    assert.equal(pick(volunteers, refills), 'anna');
  });

  test('refills older than the fairness window do not count', () => {
    const volunteers = [volunteer('anna', 'OSL'), volunteer('bjorn', 'OSL')];
    const refills = [pastRefill('anna', '2026-01-01'), pastRefill('anna', '2026-02-01'), pastRefill('bjorn', '2026-10-01')];
    assert.equal(pick(volunteers, refills), 'anna'); // anna has 0 refills in the last 90 days
  });

  test('on equal counts, whoever refilled longest ago goes first, then id (deterministic)', () => {
    const volunteers = [volunteer('anna', 'OSL'), volunteer('bjorn', 'OSL'), volunteer('kari', 'OSL')];
    const refills = [pastRefill('anna', '2026-10-20'), pastRefill('bjorn', '2026-10-01'), pastRefill('kari', '2026-10-01')];
    const ranked = rankCandidates({ office: oslo, volunteers, refills, triedIds: [], now: NOW, rules: RULES });
    assert.deepEqual(
      ranked.map((c) => c.volunteer.id),
      ['bjorn', 'kari', 'anna'],
    );
  });

  test('volunteers on holiday today are skipped', () => {
    const volunteers = [volunteer('anna', 'OSL', { away: [{ from: '2026-11-09', to: '2026-11-13' }] }), volunteer('bjorn', 'OSL')];
    assert.equal(pick(volunteers), 'bjorn');
  });

  test('a holiday that ended yesterday does not block anyone', () => {
    const volunteers = [volunteer('anna', 'OSL', { away: [{ from: '2026-11-01', to: '2026-11-09' }] })];
    assert.equal(pick(volunteers), 'anna');
  });

  test('a visitor joins the host office rotation and leaves their home rotation', () => {
    const arjun = volunteer('arjun', 'BLR', { visits: [{ officeId: 'OSL', from: '2026-11-09', to: '2026-11-20' }] });

    assert.equal(pick([arjun]), 'arjun'); // eligible in Oslo
    const inBengaluru = pickBuyer({
      office: OFFICES.BLR,
      volunteers: [arjun],
      refills: [],
      triedIds: [],
      now: NOW,
      rules: RULES,
    });
    assert.equal(inBengaluru, null); // not asked to refill a box 7 000 km away
  });

  test('inactive volunteers, people already asked, and people busy with another refill are skipped', () => {
    const volunteers = [
      volunteer('anna', 'OSL', { active: false }),
      volunteer('bjorn', 'OSL'),
      volunteer('kari', 'OSL'),
      volunteer('lars', 'OSL'),
    ];
    const busyElsewhere = { officeId: 'BLR', state: S.COMMITTED, assigneeId: 'kari', purchase: null };
    assert.equal(pick(volunteers, [busyElsewhere], ['bjorn']), 'lars');
  });

  test('returns null when nobody is available', () => {
    assert.equal(pick([volunteer('anna', 'OSL')], [], ['anna']), null);
  });
});
