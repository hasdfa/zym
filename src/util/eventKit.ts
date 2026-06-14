/*
 * eventKit.ts — quilx's event/lifecycle primitives.
 *
 * A small, self-contained equivalent of the `event-kit` package: a `Disposable`
 * (an undoable action), a `CompositeDisposable` (a bag of them disposed
 * together), and an `Emitter` (named-event pub/sub returning Disposables). The
 * command/keymap managers and the vim layer all lean on these for subscription
 * cleanup, so they carry the same shape ported code expects.
 */

/** Anything that can be torn down once. */
export interface DisposableLike {
  dispose(): void;
}

export class Disposable implements DisposableLike {
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

/**
 * A collection of disposables disposed as a unit. Adding to an already-disposed
 * composite disposes the newcomer immediately, so late subscriptions can't leak.
 */
export class CompositeDisposable implements DisposableLike {
  private disposed = false;
  private readonly disposables = new Set<DisposableLike>();

  constructor(...disposables: DisposableLike[]) {
    for (const disposable of disposables) this.add(disposable);
  }

  add(...disposables: DisposableLike[]): void {
    for (const disposable of disposables) {
      if (this.disposed) disposable.dispose();
      else this.disposables.add(disposable);
    }
  }

  remove(disposable: DisposableLike): void {
    this.disposables.delete(disposable);
  }

  /** Dispose and drop every member, but keep the composite itself usable. */
  clear(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
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
