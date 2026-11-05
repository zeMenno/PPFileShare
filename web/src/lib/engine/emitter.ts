type Handler<T> = (value: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  #handlers = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const fn of this.#handlers.get(event) ?? []) fn(value);
  }
}

/**
 * Base for engine objects the UI renders. Subclasses implement snapshot() and call
 * changed() whenever something visible moved; listeners get a batched "change".
 */
export abstract class Observable<Snapshot> extends Emitter<{ change: Snapshot }> {
  #scheduled = false;

  abstract snapshot(): Snapshot;

  /** Notify listeners soon (batched to at most ~8 times per second). */
  protected changed(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.emit('change', this.snapshot());
    }, 120);
  }
}
