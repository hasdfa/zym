# Memory leak investigation

Status: **ROOT CAUSE FOUND, FIXED, AND VALIDATED.** Durable write-up lives in
`docs/lifecycle-and-disposal.md` (rule 9 + incident). This file is the
investigation log.

## Symptom

The long-running editor grew to multiple GB of RSS and never gave it back, even
with nothing open. Flat JS heap (`heapUsed` ≈ 183 MB) + huge RSS (≈ 4.6 GB) +
77,576 detached `GtkLabel` wrappers surviving forced GC = a native node-gtk
pinning leak, not a JS-heap leak.

## Root cause (decisive)

Per-list-row **event controllers whose signal closures node-gtk roots**. Each
match row carried a hover controller:

```ts
const hover = new Gtk.EventControllerMotion();
hover.on('enter', () => listBox.selectRow(row));   // node-gtk roots this closure
row.addController(hover);
```

node-gtk keeps a persistent (global) handle on the closure for as long as the
controller stays connected. When a row is removed from the list (the file picker
pops surplus rows on **every keystroke**) without removing the controller, the
rooted closure pins the whole `row → box → labels` subtree forever. The file
picker churns the most rows, so its leaked rows dominate the 77k labels.

## How it was proven (live CDP, GLib loop running)

Built `Gtk.ListBox` rows in the live process, removed them, dropped all JS refs,
forced GC (`HeapProfiler.collectGarbage`), checked survivors via `WeakRef`:

| Variant | Survivors | Verdict |
|---|---|---|
| row removed, **no** controller | 0 / 300 | collected |
| row removed, hover controller (current code) | 300 / 300 | **leak** |
| row removed, then `removeController` | 0 / 300 | **fix works** |
| whole tree dropped, detach **only** rows (ancestor controller left) | 0 / 200 | fix works on close too |

Notes that corrected earlier theories:
- It is **not** CompletionPopup: its rows carry no controllers, so they collect
  fine (the decisive experiment showed 0 survivors). It churns widgets but does
  not leak them.
- The "800 controllers vs 77k labels" paradox: the closure captures `row`+
  `listBox`, not `hover`, so most `EventControllerMotion` *wrappers* get
  collected (native objects survive on the leaked rows) and undercount.
- The leak isn't observable under `node --test` (no GLib loop → node-gtk's
  toggle-ref collection never runs; even genuinely-free rows read as alive), so
  the regression test asserts controller removal directly, not collection.

## Fix

Two parts:

1. **Dropped select-on-hover.** The Picker (match + action rows) and Combobox
   rows only had controllers to implement "hover moves the selection". That
   affordance was removed — selection is keyboard- and click-driven (`row-
   activated`) — so those rows now carry **no controller at all** and can't leak.
2. **`src/util/widgetControllers.ts`** (`trackController` / `detachControllers`,
   WeakMap-tracked; `observeControllers()` can't be enumerated in this node-gtk
   build) for the controllers that legitimately remain on churned rows:
   `src/ui/GitPanel.ts` rebuilds rows carrying a double-click `GestureClick` on
   every git poll, and detaches them before removal.

Regression test: `src/ui/Picker.test.ts` — "match rows carry no event controllers
(select-on-hover removed, no leak)", using `observeControllers().nItems`.

## Same class, still open (follow-up)

`NotificationToasts` (toast card `GestureClick` pinned when the revealer is
removed; `fillCard` reuse stacks controllers on replaceable toasts), and any
other recycled/removed widget that carries a controller. The card *shell* of a
closed FloatingCard may also linger via its own focus controller — bounded (one
panel per close), not the row subtrees, which the fix collects.
