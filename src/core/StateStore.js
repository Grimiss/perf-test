export class StateStore {
  #state;
  #listeners = new Set();
  #revision = 0;

  constructor(initialState) {
    this.#state = structuredClone(initialState);
  }

  getState() {
    return this.#state;
  }

  get revision() {
    return this.#revision;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.#state, { revision: this.#revision, reason: "initial" });
    return () => this.#listeners.delete(listener);
  }

  update(mutator, meta = {}) {
    const next = structuredClone(this.#state);
    mutator(next);
    this.#state = next;
    this.#revision += 1;
    const info = { revision: this.#revision, ...meta };
    for (const listener of this.#listeners) listener(this.#state, info);
    return this.#state;
  }
}
