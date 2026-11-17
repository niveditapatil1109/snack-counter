/**
 * Domain errors. Each one maps to a clear message the chat bot can show the
 * user ("Someone else already took this refill") instead of a stack trace.
 */
export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Bad input, such as a negative amount or a missing receipt. */
export class ValidationError extends DomainError {}

/** Tried to add or compare two different currencies. */
export class CurrencyMismatchError extends DomainError {
  constructor(a, b) {
    super(`Cannot combine ${a} with ${b}. Convert explicitly first.`);
  }
}

export class NotFoundError extends DomainError {}

/** The person is not allowed to do this, e.g. accepting someone else's offer. */
export class NotAllowedError extends DomainError {}

/** The refill is no longer in a state where this action makes sense. */
export class RefillUnavailableError extends DomainError {}

/** The state machine does not allow moving from one state to another. */
export class InvalidTransitionError extends DomainError {
  constructor(from, to) {
    super(`A refill cannot move from ${from} to ${to}`);
  }
}

/**
 * Optimistic locking failure: somebody else changed the record after we read
 * it. The caller should re-read and decide again.
 */
export class ConcurrentUpdateError extends DomainError {}
