export class OperationGate {
  #revision = 0;

  begin() {
    this.#revision += 1;
    return this.#revision;
  }

  isCurrent(token) {
    return token === this.#revision;
  }

  invalidate() {
    this.#revision += 1;
  }
}
