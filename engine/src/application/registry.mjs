export class OperationRegistry {
  #operations = new Map();
  register(name, handler) {
    if (this.#operations.has(name)) throw new Error(`Duplicate operation ${name}`);
    this.#operations.set(name, handler);
    return this;
  }
  async execute(actor, name, payload) {
    const handler = this.#operations.get(name);
    if (!handler) throw new Error(`Unsupported operation: ${name}`);
    return handler(actor, payload);
  }
}
