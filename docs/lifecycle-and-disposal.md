# Lifecycle & disposal

How zym tears things down — load-bearing, not hygiene. A missed teardown
pins a whole subsystem (or a `TextEditor` per file ever opened) alive. Read
this before adding a component that owns a GObject, handler, timer, or child.

## Why "the GC will get it" is false here

- **GTK widgets are detached, not destroyed, on close.** Closing a tab /
  switching a diff mode / hiding a panel **unparents** the root; it does not
  emit `destroy`. So cleanup gated only on `widget.on('destroy', …)` never
  runs — teardown must come from an explicit `dispose()`.
- **node-gtk pins native objects.** It never frees GObjects from GI `.new()`
  / transfer-full returns (`romgrk/node-gtk#446`), and a handler on a
  long-lived GObject is held by a persistent handle whose closure captures
  `this` — pinning your whole graph. Signature: flat V8 heap + growing RSS,
  invisible to the JS profiler.

So **a subscription to a global/long-lived object is a strong ref that
outlives the widget tree, and must be cut by hand.**

## Primitives — `src/util/eventKit.ts`

`Disposable(action)` (idempotent), `CompositeDisposable` (a bag; adding after
dispose disposes immediately, so late subs can't leak), `Emitter` (returns
`Disposable`s). Track a component's subs in one `CompositeDisposable` and
dispose it as a unit.

## The rules

1. **`dispose()` is idempotent** — guard
   `if (this.disposed) return; this.disposed = true`.
2. **Disconnect global/long-lived handlers in `dispose()`**, never gated on
   `destroy` alone. Store the disconnect as a field (e.g. `detachStyleScheme`)
   and call it.
3. **`widget.on('destroy', () => this.dispose())` is a safety net, not the
   path** — always also dispose explicitly from the owner.
4. **Own what you build** — dispose every child component/editor you
   construct.
5. **No GObject churn in poll/hot paths** — caching one long-lived object or
   shelling out beats `<Type>.new()` per tick (which grows the heap unbounded
   → growing GC hangs).
6. **Detach overlay children by hide+pool, never `unparent`**
   (`gtk_text_view_remove` is a no-op; forcing it → snapshot CRITICAL). See
   [text-editor/inline-widgets.md](text-editor/inline-widgets.md).
7. **Clear timers** in `dispose()` (`setTimeout`/`setInterval` ids).
8. **Prefer `WeakMap` for per-widget side tables** — a missed disposal
   degrades to dead data, not a pinned widget.

## Reference — `TextEditor.dispose()`

`src/ui/TextEditor/TextEditor.ts`, in order: guard `disposed`;
`detachStyleScheme()` (global `Adw.StyleManager`, rule 2); remove the `map`
handler; dismiss hover/signature popovers; `syntax.dispose()` (buffer/view
handlers + tree-sitter tree); detach from the shared `Document` (the registry
disposes it only when the **last** view releases it — disposal often needs
ref-counting, not blind teardown); dispose diagnostics + inlay renderers.

## Hunting a leak

Inspector on the live process (`kill -SIGUSR1 <pid>` or `--inspect`), drive
CDP: `HeapProfiler.takeHeapSnapshot`, count live objects **by constructor**
(climbing `TextEditor`/`GtkLabel`/`Ggit*` = the leak; two post-GC snapshots
seconds apart prove retention vs GC lag), then trace the shortest retainer
path — `(Global handles) → closure → … → your object` is a node-gtk-pinned
handler (rule 2). Native leak = `app.run()` frame dominates CPU with JS idle
+ flat heap + growing RSS.

## Incidents

- **StyleManager handler → a `TextEditor` per file** — disconnected only on
  `destroy`, which tab-close never fires. Fixed via `detachStyleScheme` in
  `dispose()` (rule 2).
- **Git poll → libgit2 GObject leak → growing hangs** — fixed by moving
  `src/git.ts` off `Ggit` to the `git` CLI (rule 5). See
  [git/index.md](git/index.md).
- **Overlay-child `unparent` crash** — fixed with the hide+pool slot pattern
  (rule 6).
