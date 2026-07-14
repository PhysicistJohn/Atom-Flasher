export class OperationGate {
  #active: string | undefined;
  #idleWaiters = new Set<() => void>();

  get active(): string | undefined { return this.#active; }

  async run<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
    if (this.#active) throw new Error(`Operation ${this.#active} is already active; ${name} was not started`);
    this.#active = name;
    try { return await operation(); }
    finally {
      this.#active = undefined;
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    }
  }

  peek<T>(snapshot: () => T): T {
    // JavaScript executes this synchronously between mutation turns. It never
    // invokes updater I/O or changes device/updater state.
    return snapshot();
  }

  whenIdle(): Promise<void> {
    if (!this.#active) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }
}
