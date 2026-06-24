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

---

# Investigation #2: project-search results view churns native GObjects

Status: **FIXED.** Distinct from investigation #1. Same leak *class* (a connected
controller's closure node-gtk roots), different site. Hunt performed live against
the running editor instance (PID `3500205`) via the Node inspector (`SIGUSR1` →
CDP on `127.0.0.1:9229`). Upstream node-gtk bug filed: **romgrk/node-gtk#455**.

## Summary

`ProjectSearchView.runSearch()` rebuilds the **entire** results view on every
search run (`swapResults(new SearchResultsView(...))`). The new `SearchResultsView`
attaches Enter / double-click `EventController`s to its editor's source view
(`installNavigation`) with raw `view.addController(...)`, and `dispose()` never
removes them. Each handler closure captures `this`, and node-gtk keeps a connected
handler's closure **strong-rooted** — so the disposed-but-not-detached view stays
pinned: its editor, every `Document` it acquired from the registry, those
documents' buffers, the ~24 highlight `GtkTextTag`s per buffer, and the
excerpt-header rows. One leaked graph per search ⇒ unbounded RSS growth.

> **Corrected from the first draft of this note:** the leak is *not* the
> `.new()`-never-freed bug (#446). A standalone repro (`/tmp/zym-leak/ngtk-repro*.cjs`)
> showed bare `new Gtk.TextTag()` / `new Gtk.ListBoxRow()` — even a row carrying a
> controller — collect cleanly after GC. The leak fires **only when the handler
> closure captures the object**; the tags/rows are collateral, pinned because their
> owning view is pinned. See node-gtk#455.

Observed: RSS climbed **412 MB → ~3300 MB** over a few minutes while the V8 heap
stayed small and flat — the classic node-gtk "flat JS heap, fat native RSS"
signature.

## Where

- `src/ui/ProjectSearchView.ts`
  - `runSearch()` → `swapResults(new SearchResultsView({ excerpts, … }))` (≈ line 257)
    builds a brand-new view on each run (re-query / toggle / re-open).
- `src/ui/SearchResultsView.ts`
  - constructor `new TextEditor({ … })` (line 121) → new editor per rebuild.
  - `installNavigation()` adds raw `view.addController(keys)` / `addController(click)`
    (lines 396 / 407) whose closures capture `this`.
  - `dispose()` (line 435) disposes the editor + releases sources but **never
    `removeController`s** the navigation controllers (rule 9 hazard).
- GObjects leaked per rebuild:
  - `new Gtk.TextTag()` highlight vocabulary, ~24 per editor —
    `src/syntax/highlightTags.ts:46`, `src/syntax/syntax-controller.ts:220`.
  - `new Gtk.ListBoxRow()` excerpt headers via BlockDecorations —
    `src/ui/LocationList.ts:130`.

## Proof chain

| Signal | Evidence |
|---|---|
| Native-pin shape | RSS **412 → 3300 MB** while V8 `heapUsed` stayed ~60–130 MB and `external` flat at 51 MB. |
| Steady growth (passive 90 s, app idle) | `GtkTextTag +155`, `GtkListBoxRow +200`, plus `CompositeDisposable +30`, `didDispatch +57`, and the string `"TextEditor: [alt-j]: vim-mode-plus:move-down"` 2 → 48 (vim editors created + freed, tags/command artifacts left behind). |
| Detached but pinned | Retainer paths: every sampled `GtkTextTag` / `GtkListBoxRow` is rooted at **depth 1 by `(Global handles)`** with no widget-tree path to the window. |
| Stable JS, growing native | `TextEditor` count steady at 24 while `GtkTextTag` went 590 → 1523 → tags **outlive their editors** (≈ 24 new tags ≈ one editor vocabulary every ~15 s). |
| Allocator (sampling profiler, caught a burst) | `new SearchResultsView` (`SearchResultsView.ts:97`) ← `ProjectSearchView.ts:245` ← `runProjectSearch` callback (`multibuffer/projectSearch.ts:116`) ← runner IPC stream. Children: `attachVim`, `DocumentSyntax.reparse` (tags), `LocationList.buildRow` / `BlockDecorations.add` (rows). |

The churn is **bursty** (a rebuild per search run, not a per-frame loop): RSS
jumps sharply when a search runs and drips slowly between runs.

## Root cause (decisive)

A connected controller whose closure captures its own object keeps the object
strong-rooted in node-gtk until the controller is removed (node-gtk#455, proven by
standalone repro: capturing closure → 500/500 survive GC; `removeController` first
→ 0/500). `SearchResultsView.installNavigation` leaves such controllers on the
source view, and `dispose()` never removes them — so each disposed view is pinned
via its captured `this`, dragging the whole editor + acquired-`Document` graph
(and their buffers / tags / rows) with it. `runProjectSearch` runs `rg` once per
run (`multibuffer/projectSearch.ts:105–127`); each re-query rebuilds and leaks one
more graph. Confirmed by counts across snapshots ~3 min apart: `TextEditor`
24→42, `Document` 15→64, `GtkSourceBuffer` 25→92, `GtkTextTag` 590→1526.

## Fix (done)

`src/ui/SearchResultsView.ts`:

1. `installNavigation()` now attaches the Enter / double-click controllers via
   `trackController(view, …)` instead of raw `view.addController(…)`.
2. `dispose()` calls `detachControllers(this.editor.sourceView)` **before**
   `this.editor.dispose()` (while the view still exists), severing the rooted
   closures so the view — and the editor / Documents / buffers / tags / rows it
   holds — becomes collectable.

This breaks the captured-`this` cycle (mirrors the repro's `removeController`
case → 0 survivors). `pnpm run typecheck` passes. Live verification needs an
editor restart (the running instance still has the old code).

Optional follow-up (not required for the fix): have `ProjectSearchView` reuse one
persistent `SearchResultsView` and update excerpts in place (rule 5 — avoid the
per-query editor churn entirely), and add a regression test asserting the source
view carries no tracked controllers after `dispose()` (cf. `Picker.test.ts`).

When fixed, add this to `docs/lifecycle-and-disposal.md` Incidents.

## Reproduction / tooling

Scratch tooling lives in `/tmp/zym-leak/` (ephemeral):

- `cdp.mjs` — minimal CDP driver (Node global `WebSocket`):
  - `WS=ws://… node cdp.mjs eval '<expr>'`
  - `WS=… node cdp.mjs snapshot <file>` (GC + `HeapProfiler.takeHeapSnapshot`)
  - `WS=… node cdp.mjs sample <seconds>` (allocation sampling profiler → top frames + stacks)
- `analyze.mjs <snap>` / `analyze.mjs <a> <b>` — aggregate a heapsnapshot by
  constructor, or diff two (biggest growers).
- `retain.mjs <snap> count|path <Ctor>` — count instances; trace retainer paths
  up to a GC root (reverse-BFS over the heap graph).

Recipe:

```sh
kill -SIGUSR1 <editor-pid>                 # opens inspector on 127.0.0.1:9229
WS=$(curl -s 127.0.0.1:9229/json/list | jq -r '.[0].webSocketDebuggerUrl')
WS=$WS node cdp.mjs snapshot a.heapsnapshot
WS=$WS node cdp.mjs eval '(async()=>{await new Promise(r=>setTimeout(r,90000))})()'
WS=$WS node cdp.mjs snapshot b.heapsnapshot
node analyze.mjs a.heapsnapshot b.heapsnapshot   # biggest growers
node retain.mjs b.heapsnapshot path GtkTextTag   # → "(Global handles)" depth 1
WS=$WS node cdp.mjs sample 60                     # names the allocating call stack
```

Notes:
- The inspector left open on PID `3500205` closes when the editor restarts.
- The running instance is at ~3.3 GB; a restart reclaims it.

---

# Investigation #3: the controller-pin leak class is systemic, not site-local

Status: **FIXED.** A generic disposal mechanism (the `CompositeDisposable`
acquire-and-defer helpers — `addController`/`connect`/`timer`/`nest`/…) now
funnels every controller + handler, and all ~13 sites below were migrated onto
it (added a `dispose()` where one was missing and wired it to each widget's drop
point; `nest()` for churned widgets; `BlockDecorationSpec.dispose` for the
`HeaderBands`; retired the per-class `connect` helper + `widgetControllers.ts`).
Verified: `pnpm run typecheck` + `pnpm run lint` clean; `node --test` green
(incl. a new GTK-level regression `src/util/eventKit.gtk.test.ts` asserting
`addController` + `dispose()` → 0 controllers on a real widget, and `nest()`
re-arm). The durable write-up is `docs/lifecycle-and-disposal.md` (Primitives +
rule 9 + Incidents). Original findings below.

---

Status (at discovery): **AUDIT COMPLETE + MECHANISM AND ONE SITE PROVEN LIVE; ~13
sites open (unfixed).** Hunt run against the live editor I was running inside (PID
`3577604`, fresh — already has the #1/#2 fixes) via the Node inspector
(`SIGUSR1` → CDP on `127.0.0.1:9229`). Same leak *class* as #1/#2
(`node-gtk#455` — a connected controller's signal closure is strong-rooted),
but #1 and #2 each patched one site. This pass shows the pattern is **endemic**:
of ~30 `addController` call sites, only the 2 already fixed
(`SearchResultsView`, `GitPanel`) sever their controllers; the rest leak when
their widget is dropped.

## The decisive generalization (live in-process bisection)

`/tmp/zym-leak/probe-controllers.mjs` builds 300 widgets per variant in the live
process (real node-gtk build + running GLib loop, so toggle-ref collection
actually fires), each carrying a controller whose `key-pressed` closure captures
a `{ widget, sentinel }` graph; removes the widget from its parent; drops all JS
refs; forces GC; counts `WeakRef` survivors:

| Variant | Pattern (which real sites) | Survivors | Verdict |
|---|---|---|---|
| A | raw `addController` + `c.on(sig, …)`, **no** detach/disconnect | **300 / 300** | **LEAK** |
| B | same, but `c.off(sig, handler)` before drop | 0 / 300 | collected — **disconnecting the handler releases the pin** |
| C | same, but `widget.removeController(c)` before drop | 0 / 300 | collected — `removeController` releases the pin |

This pins down the **discriminator** the whole audit rests on: a controller site
is safe iff, before the widget is dropped, **either** the handler is disconnected
(`off`) **or** the controller is removed. `TextEditor` routes every controller
through a `connect()` helper (`obj.on` + `subs.add(Disposable(() => obj.off(…)))`,
disposed in `dispose()`) → variant B → **safe**. Every other site uses raw
`addController` + raw `c.on(…)` and neither disconnects nor removes → variant A
→ **leaks when its widget is dropped**.

## One site proven live end-to-end (real app path)

`NotificationToasts` (#1 flagged it "still open"). Drove **80 reuses of one
`replaceKey`** through the real `zym.notifications.add(…, { onDidClick })` path:
each `show()` → `fillCard(prev.card, …)` re-runs and re-adds a `GestureClick`
(`NotificationToasts.ts:209`) to the *same* card without removing the prior one;
then the card auto-expired (15 s) and left the tree. Post-GC heapsnapshot diff:

| Grower | Δ | note |
|---|---|---|
| `GtkGestureClick` | **+80** | one stacked per `fillCard`, none removed |
| `closure remove` / `forget` / `cancelTimer` / `onDidClick` | +80 each | the rooted `released` closure + what it captures |
| `Notification` / `Date` / `Emitter` | +80 each | every **superseded** notification pinned forever |
| `GtkLabel` / `GtkBox` | +723 / +482 | collateral card-subtree content |

`retain.mjs toast-b path GtkGestureClick` → every sample rooted at
**`(Global handles)` depth 1**, no widget-tree path — the node-gtk persistent-handle
signature, *after* the card was removed from the tree. So one notification key
permanently leaked 80 native controllers + 80 notification graphs. Both the
per-removal leak (card dropped with controller attached) and the `fillCard`
stacking leak are real.

## Full audit — every `addController` site (raw unless noted)

SAFE (handler disconnected on dispose via `connect()`):
- `TextEditor.ts:707, :1588, :1794` — all via `connect()` (variant B).
- `SearchResultsView.ts:402/413`, `GitPanel.ts:346` — `trackController` +
  `detachControllers` (variant C; fixed in #2 / rule 9).
- `src/poc/*` — dead code (not imported outside `poc/`).

LEAK (raw `addController` + raw `.on`, owner churns, no disconnect/removeController):

| Site | Controller | Owner churn | Pinned graph |
|---|---|---|---|
| **`DiffView.ts:645/656`** | Key (Enter) + GestureClick (dbl-click) on `editor.sourceView` | per diff / per re-diff | **byte-for-byte the #2 pattern** — editor + acquired Documents + buffers + ~24 tags/buffer + header rows. `dispose()` (1016-1043) never removes them. **Highest impact.** |
| **`CompletionController.ts:422`** | Key (capture) on `editor.view` | per editor (file open/close) | CompletionController → editor → view → buffer → tags. `dispose()` (78-90) only clears a timeout + `popup.dispose()`. |
| **`HeaderBands.ts:68/86`** | GestureClick on band row / `⋯` gap | per keystroke (search) / per re-diff | discarded header/gap subtrees + the view (`onActivate`/`onExpand` capture `this` of SearchResultsView/DiffView). `BlockDecorations` detaches the widget but never the controller. High churn. |
| `SearchBar.ts:374/382` | Key + Focus on `panel` | per editor | whole SearchBar graph; **class has no `dispose()`**. |
| `buildDefinitionPeek.ts:79` | Key (Escape) on peek `card` | per go-to-def peek | peek card + nested editor (`onClose` capture); `Peek.close()` never disposes/removes. |
| `Terminal.ts:333` | Focus on the `Vte.Terminal` | per terminal tab | Terminal + Vte + scrollback; **no `dispose()`**. |
| `FloatingCard.ts:128/200` | GestureClick on `scrim` + Focus on `panel` | **every** picker / palette / find / launcher open | the whole card content (Picker list / launcher); `close()` removes the overlay child but no controllers; **no `dispose()`**. |
| `Combobox.ts:122/127/135` | Click + Key + Focus on `entry` | 4-5 per AgentLauncher open | whole Combobox (entry + popover + list); **no `dispose()`**. |
| `Panel.ts:214/261` | Focus on `root` + GestureClick on empty-state | per split-collapse / per agent workbench | whole Panel graph; **no `dispose()`**. |
| `QuestionCard.ts:133/138/160` | Focus + Key per option, Key on `root` | per AskUserQuestion (+ per option) | QuestionCard graph; option `note`s detached on submit with controllers attached; **no `dispose()`**. |
| `AgentConversation.ts:345` | Motion on `transcriptOverlay` | per agent | whole conversation graph; `dispose()` exists but never removes it. |
| `AppWindow.ts:934` | Focus on `agent.root` | per agent close | the **entire closed agent** (`enter` closure captures `agent`); `closeAgent` drops `agent.root` without removing it. |

## Fix shape (uniform)

Route each through `trackController(widget, c)` (or keep the raw `addController`
but register `c.off(sig, handler)`), then sever before the widget is dropped:
`detachControllers(widget)` in the owner's `dispose()`/`close()`/teardown — and
add a `dispose()` to the classes that lack one (`SearchBar`, `Terminal`,
`Combobox`, `Panel`, `QuestionCard`, `FloatingCard`). For `NotificationToasts`,
remove the old `GestureClick` before `fillCard` re-adds one, and on `animateOut`.
`DiffView` is the exact twin of the already-fixed `SearchResultsView` and should
be fixed the same way first.

## Tooling

Adds `/tmp/zym-leak/probe-controllers.mjs` (the A/B/C variant bisection) to the
#2 toolkit. App internals are reachable from the inspector via `globalThis.zym`
(`.workspace`, `.commands`, `.notifications`, `.agents`, …), which is how the
toast path was driven live without a synthetic repro.

---

# Investigation #4: `GtkSource.Annotation.new()` churn — a `.new()`-pin leak, not a controller leak

Status: **RESOLVED UPSTREAM — root cause was node-gtk#446, now FIXED in node-gtk;
re-proven collected; app-level workaround reverted.** Hunt run against the live
editor I was running inside (PID `3843893`, started *after* the #1/#2/#3 fixes) via
the Node inspector (`SIGUSR1` → CDP on `127.0.0.1:9229`). This is a **different
leak class** from #1/#2/#3: not a connected-controller closure pin (node-gtk#455)
but the **transfer-full `.new()` return that node-gtk used to never free
(node-gtk#446)** — i.e. rule 5 ("no GObject churn in poll/hot paths"), not rule 9.
The proper fix was upstream: **node-gtk#446 was fixed** (binary rebuilt
2026-06-24 11:19:59) and the temporary app-level diff-and-skip in `VirtualText.ts`
was reverted (see Resolution below).

## Symptom / signature

`process.memoryUsage()`: RSS **1449 MB**, `heapUsed` **190 MB**, `external` 55 MB
— the classic flat-JS-heap / fat-native-RSS node-gtk pin. Two **post-GC**
heapsnapshots ~5 min apart (`cdp.mjs snapshot` GCs first) showed
`GtkSourceAnnotation` **1040 → 1541 (+501)**, with correlated `Point +462`,
`Range +230`, `Marker +22`, `GtkTextMark +22`. (`GtkLabel` sat at ~21.7k but was
**not growing** — historical residue, see below.)

## Proof chain

| Signal | Evidence |
|---|---|
| Active retention (not GC lag) | +501 `GtkSourceAnnotation` across two **post-GC** snapshots. |
| Detached but pinned | `retain.mjs leakB path GtkSourceAnnotation` → every sample rooted at **`(Global handles)` depth 1**, no widget-tree path (they've been `removeAll()`'d off the provider). |
| Single creation site | only `src/ui/TextEditor/VirtualText.ts:59`, `GtkSource.Annotation.new(text, null, line, style)`. |
| Allocator (sampling) | repeated stacks under git `pollOnce` rebuild widgets, but the annotation churn is driven by `InlayHintController.apply` / `GitBlameController` / `DiagnosticsView`, which re-push their full list on edit/cursor/fold/re-fetch. |
| Isolated `.new()` repro (live, in-process) | created 1000 `GtkSource.Annotation.new()`, dropped all JS refs, forced GC twice → **1000/1000 survive** ⇒ #446, independent of provider/controllers. |
| Not mutable / not freeable | annotation proto has only `description`/`line`/`style` **getters** (setting them is a no-op); node-gtk exposes no `unref`/`free` → can't pool-and-mutate, can't reclaim. |

## Root cause (decisive)

`VirtualText.setAnnotations()` did `provider.removeAll()` then
`addAnnotation(GtkSource.Annotation.new(...))` per item on **every** call. The
producers — `InlayHintController` (`apply()` from both `refresh()` and
`rerender()`), `GitBlameController` (per cursor move), `DiagnosticsView` (per
diagnostics push) — recompute and re-push their full list constantly, almost
always identical to what's already rendered. Each rebuild leaks one permanently-
pinned native `GtkSource.Annotation` per line (#446). `removeAll()` only drops the
provider's reference; the persistent handle keeps the native object forever.

## Resolution — node-gtk#446 fixed upstream

The real fix was in node-gtk: transfer-full `.new()` returns now downgrade their
toggle-ref and are freed once JS drops them. Re-ran the isolated repro
(`/tmp/zym-leak/repro446.cjs`: create N via `.new()`, drop refs, spin the GLib
loop, `global.gc()`, count `WeakRef` survivors) against the **rebuilt** binary
(`/home/romgrk/src/node-gtk/build/Release/node_gtk.node`, 2026-06-24 11:19:59):

| Variant | Old binary | Rebuilt |
|---|---|---|
| `GtkSource.Annotation.new()` dropped | 1000/1000 pinned | **0/1000 collected** |
| `addAnnotation → removeAll → drop` (the VirtualText path) | leaked | **0/1000 collected** |
| controls (plain object, `new Gtk.Button()`) | collected | collected |

So `VirtualText`'s rebuild-per-update no longer leaks. The temporary app-level
diff-and-skip guard I had added to `src/ui/TextEditor/VirtualText.ts` was
**reverted** (file back to HEAD) — the upstream fix is the correct layer. Rule 5
still applies as guidance (churning `.new()` in a hot path is needless native
alloc/GC pressure), so a diff-and-skip in `VirtualText` remains a reasonable
*perf* optimization if the churn ever shows up in a profile, but it is no longer a
correctness/leak requirement.

Note: the running editor that exhibited the leak (PID `3843893`) still has the
**old** node-gtk mapped; it keeps its accumulated annotations until restarted. The
freshly-restarted instance (PID `4102255`, started 11:20:55 — after the rebuild)
loads the fixed binary.

## Aside — the ~21.7k `GtkLabel` residue (not this leak)

Large but **flat** across the window (≈ +0 over 5 min), all at `(Global handles)`
depth 1 — accumulated detached labels from earlier churn (the still-open
`NotificationToasts` follow-up from #1/#3 — 75 notifications retained — plus diff/
completion/git-row churn over the ~12 h uptime). Reclaimed only by restart; not
actively growing, so not the active leak. Track under the #3 NotificationToasts
follow-up.

## Tooling / recipe (unchanged from #2)

```sh
kill -SIGUSR1 <editor-pid>
WS=$(curl -s 127.0.0.1:9229/json/list | jq -r '.[0].webSocketDebuggerUrl')
WS=$WS node /tmp/zym-leak/cdp.mjs snapshot leakA.heapsnapshot      # GCs first
WS=$WS node /tmp/zym-leak/cdp.mjs snapshot leakB.heapsnapshot      # minutes later
node /tmp/zym-leak/analyze.mjs leakA.heapsnapshot leakB.heapsnapshot   # growers
node /tmp/zym-leak/retain.mjs  leakB.heapsnapshot path GtkSourceAnnotation
# isolated #446 check: require('node-gtk').require('GtkSource'); 1000× .new(); drop; gc; count WeakRef survivors
```
