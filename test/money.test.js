import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CurrencyMismatchError, ValidationError } from '../src/domain/errors.js';
import { Money, sum } from '../src/domain/money.js';

test('money is exact: 0.10 + 0.20 is exactly 0.30 (floats would give 0.30000000000000004)', () => {
  const total = Money.of(0.1, 'NOK').plus(Money.of(0.2, 'NOK'));
  assert.ok(total.equals(Money.of(0.3, 'NOK')));
  assert.equal(total.minor, 30);
});

test('adding NOK to INR is refused instead of silently producing nonsense', () => {
  assert.throws(() => Money.of(100, 'NOK').plus(Money.of(100, 'INR')), CurrencyMismatchError);
  assert.throws(() => Money.of(100, 'NOK').isLessThan(Money.of(100, 'INR')), CurrencyMismatchError);
  assert.throws(() => sum([Money.of(1, 'NOK'), Money.of(1, 'INR')], 'NOK'), CurrencyMismatchError);
});

test('fractions of an øre or a paisa are rejected', () => {
  assert.throws(() => new Money(1.5, 'NOK'), ValidationError);
});

test('conversion uses the given rate and rounds once', () => {
  assert.equal(Money.of(15000, 'INR').convertTo('NOK', 0.1234).toString(), '1851.00 NOK');
  assert.equal(Money.of(0.05, 'INR').convertTo('NOK', 0.13).minor, 1); // 0.65 øre rounds to 1
});

test('money values cannot be changed after creation', () => {
  const amount = Money.of(10, 'NOK');
  assert.throws(() => {
    amount.minor = 999;
  }, TypeError);
});
