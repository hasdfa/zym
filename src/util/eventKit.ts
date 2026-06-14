/*
 * eventKit.ts — a tiny subset of the `event-kit` package.
 *
 * xedel's command/keymap managers return `Disposable`s from registration calls
 * and use an `Emitter` for the `did-dispatch` hook. Rather than pull in the full
 * dependency we provide just those two primitives, with the same shape.
 */

export class Disposable {
  private disposed = false;
  private readonly action: () => void;

  constructor(action: () => void) {
    this.action = action;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.action();
  }
}

type Handler = (value?: unknown) => void;

export class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(eventName: string, handler: Handler): Disposable {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    set.add(handler);
    return new Disposable(() => set!.delete(handler));
  }

  emit(eventName: string, value?: unknown): void {
    const set = this.handlers.get(eventName);
    if (!set) return;
    for (const handler of set) handler(value);
  }
}
