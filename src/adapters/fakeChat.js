/**
 * Simulated chat tool. It records every message instead of sending it, so
 * tests can assert "Kari was asked" or "the admin was pinged".
 * Pass `onMessage` to print messages as they happen (used by the demo).
 */
export class FakeChat {
  messages = [];

  constructor({ onMessage } = {}) {
    this.onMessage = onMessage;
  }

  async sendDirect(employeeId, text) {
    this.#record({ to: employeeId, text });
  }

  async postToChannel(officeId, text) {
    this.#record({ to: `#snacks-${officeId}`, text });
  }

  /** All message texts sent to one recipient (a person id or '#snacks-OSL'). */
  messagesTo(recipient) {
    return this.messages.filter((m) => m.to === recipient).map((m) => m.text);
  }

  lastMessageTo(recipient) {
    return this.messagesTo(recipient).at(-1);
  }

  #record(message) {
    this.messages.push(message);
    this.onMessage?.(message);
  }
}
