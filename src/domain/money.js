import { CurrencyMismatchError, ValidationError } from './errors.js';

/**
 * An amount of money in ONE currency, stored as an integer number of minor
 * units (øre for NOK, paise for INR). Floats are never used for money:
 * 0.1 + 0.2 !== 0.3 in JavaScript, but 10 + 20 === 30 always.
 *
 * Money objects are immutable: every operation returns a new Money.
 */
export class Money {
  constructor(minor, currency) {
    if (!Number.isInteger(minor)) {
      throw new ValidationError(`Money must be a whole number of minor units, got ${minor}`);
    }
    if (typeof currency !== 'string' || currency.length !== 3) {
      throw new ValidationError(`Currency must be a 3-letter ISO code, got ${currency}`);
    }
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  /** Build from a human amount: Money.of(1200, 'NOK') is 1 200.00 NOK. */
  static of(major, currency) {
    return new Money(Math.round(major * 100), currency);
  }

  static zero(currency) {
    return new Money(0, currency);
  }

  plus(other) {
    this.#assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other) {
    this.#assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  isLessThan(other) {
    this.#assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other) {
    this.#assertSameCurrency(other);
    return this.minor > other.minor;
  }

  /** The smaller of two amounts in the same currency. */
  min(other) {
    return this.isLessThan(other) ? this : other;
  }

  /**
   * Convert to another currency with an explicit rate
   * (1 unit of this currency = `rate` units of the target). Rounded once.
   */
  convertTo(targetCurrency, rate) {
    return new Money(Math.round(this.minor * rate), targetCurrency);
  }

  equals(other) {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toString() {
    return `${(this.minor / 100).toFixed(2)} ${this.currency}`;
  }

  #assertSameCurrency(other) {
    if (!(other instanceof Money)) {
      throw new ValidationError('Expected a Money value');
    }
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** Add up a list of Money values in one currency. */
export function sum(amounts, currency) {
  return amounts.reduce((total, amount) => total.plus(amount), Money.zero(currency));
}
