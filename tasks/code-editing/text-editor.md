# Text editor widget

> Evaluation for index.md → "Code editing → Text editor": *"Consider a custom
> widget or a fork of GtkSourceView … multiple cursors, rectangular selection,
> better performance with large files. Consider a JS widget, or a Rust widget
> with a JS wrapper."*

**Decision: stay on `GtkSource.View` and emulate the two things it can't do
natively (multi-cursor, block-select); own the *model* so each view gets its own
buffer; treat a from-scratch widget as a gated escape hatch, not the next step.**

This page records why, and what each rejected path would have cost. The actual
text-editor code lives in `src/ui/TextEditor/`.

## Architecture at a glance

Two layers sit on the widget (`src/ui/TextEditor/`):

- **Document / model layer (we own the text).** `Document.ts` keeps the text in a
  **headless model `GtkSource.Buffer`** (never shown) that is the single source of
  truth + undo authority + LSP text source. Each on-screen view gets its **own**
  `GtkSource.Buffer` via `Document.createView()`, kept in sync from the model. This
  is the **A2** design (see below): the buffer stops being the model and becomes
  pure presentation, which is what lets two views of one file have independent
  cursors, folds, and decorations. `DocumentRegistry.ts` owns multi-host / active-
  view routing and ref-counting.
- **Editor logic layer (`EditorModel.ts`).** An Atom-`TextEditor`-shaped model over
  a view's buffer: `Point`/`Range`, scanning, mutation, undo, plus the seams other
  features plug into (`onDidChangeText`, viewport/pixel geometry, decorations,
  cursors/selections). `getCursors()`/`getSelections()` are **N-element** arrays
  backed by `MarkerLayer.ts` mark pairs — the seam multi-cursor plugs into. Undo is
  relocated to the `Document` via `setUndoTarget()` so it stays correct across views.

`TextEditor.ts` ties it together: a `GtkSource.View` on a `Document` view-buffer,
tree-sitter highlighting + `invisible`-tag folding (`SyntaxController`), a
`GtkSource.Map` minimap, file I/O (delegated to `Document`), LSP, and **custom vim
modal editing** (`vim/`, ported from vim-mode-plus — `GtkSource.VimIMContext` is no
longer used).

## Feature checklist vs. GtkSourceView

| Feature | On GtkSourceView | Notes |
|---|---|---|
| Syntax highlighting (tree-sitter) | **Built** (ours) | `setHighlightSyntax(false)` + own `TextTag`s. Upstream is regex `.lang` only. |
| Code folding | **Built** (ours) | No upstream fold API in GtkSource 5; we use the `invisible` `TextTag`. |
| Gutter (line nums, diagnostics, git bars) | **Native** | `GtkSourceGutterRenderer`. |
| Inline virtual text / inlay hints / diff | **Built** | `VirtualText.ts` wraps native `GtkSourceAnnotations` (5.18+; we're on 5.20). |
| Diff display (inline + side-by-side) | **Built** | `DiffView` / `SideBySideDiffView` from synthesized read-only buffers. |
| Search UI | **Built** | `SearchController` + `SearchBar`. |
| Minimap | **Native** | `GtkSource.Map`. |
| Multiple cursors / block selection | **Built (emulated)** | No native support; emulated on `MarkerLayer` (Option A). |
| Multiple *views* of one buffer (split, peek) | **Built (A2)** | Each view its own buffer, synced from the `Document` model. |
| Large line *counts* (M+ lines) | **Native, fine** | Only visible paragraphs are laid out. |
| Pathological long *single* lines (minified) | **Unfixable** | The one hard wall — see constraints. |
| IME / bidi / a11y / clipboard / DnD | **Native, free** | The expensive-to-rebuild subsystems all come free here. |

The features GtkSourceView *can't* do natively — multi-cursor, block-select, long
single lines — trace to two parts of **GtkTextView** (GTK core, below GtkSourceView)
you can't override: the single `insert`/`selection_bound` mark pair, and the
per-paragraph `PangoLayout`.

## Options considered

### Option A — stay on GtkSourceView, emulate the gaps *(chosen)*

Build multi-cursor and block-select on top, the way GNOME Builder does
(`ide-cursor.c`): a list of virtual cursors, each its own mark pair, extra carets
drawn over the text, every edit replayed per cursor. Rectangular selection is a
column of virtual cursors. In quilx this lands on the existing seam:
`EditorModel.getCursors()`/`getSelections()` are N-element over `MarkerLayer`, and
the vim layer (which iterates those arrays) gets multi-cursor largely for free.
Pros: keeps the entire built stack (vim, tree-sitter, folding, minimap, I/O); IME/
bidi/a11y/clipboard stay free; lands incrementally; lowest risk. Cons: emulated
multi-cursor is real maintenance-heavy code fighting a one-cursor buffer; doesn't
fix long lines.

### Option B — fork GtkSourceView — **rejected**

The things we fight don't live in GtkSourceView; they live in **GtkTextView**,
which is **GTK core**. To change the model (buffer/presentation split, mid-line
layout, insert-mark-is-the-cursor coupling) you'd fork GTK itself and ship it
through node-gtk forever — and the hardest part (long-line layout) still wouldn't
be fixed because it lives in `GtkTextLayout`. All the cost of owning a text stack
with none of the design benefit. Off-path for a JS/node-gtk codebase.

### Option C — own the widget (custom GTK4 text widget) — **gated escape hatch**

A from-scratch `GtkWidget` whose `snapshot()` paints code via Pango/GSK. The only
path that fixes long lines *and* makes multi-cursor/block-select native. Research
is encouraging on **rendering** (GTK4 gives a glyph atlas + retained render-node
caching; VTE proves the GTK4 path; node-gtk's `examples/gtk-4-custom-widget.js`
proves a JS `snapshot()` override) and sobering on **the surround**: you'd rebuild
the private `GtkTextLayout` middle layer (per-line layout cache + viewport
virtualization — the largest cost), plus IME, bidi, and a11y — exactly what
GtkSourceView gives free. Telling signal: no major Rust editor uses GTK (Zed/Lapce/
COSMIC went GPU-direct; the fast GTK editors are C-on-GtkSourceView).

If ever taken, the shape is **C2 — Rust core + JS rendering**: a Rust core (`ropey`
+ tree-sitter + tree-sitter-highlight + cursor model) as a napi-rs addon supplying
text/highlight-spans/cursor-geometry; the GTK4 widget stays JS/node-gtk. Keeps one
main loop, one thread, no GObject handoff, no GIR pipeline. (A fully-Rust gtk-rs
widget exposed via GIR — "C3" — is rejected: needs a manual typelib pipeline the
gtk-rs toolchain won't automate and has zero precedent.)

**The gate before any C rewrite:** a one-day node-gtk spike answering three
unknowns — (1) render perf (a `Gtk.Widget` subclass snapshotting ~50 visible lines
via cached `PangoLayout`s, scrolling/typing smoothly with `snapshot()` driven from
JS — the per-frame JS↔native FFI cost is unmeasured); (2) IME wired directly
(`GtkIMContext` commit/preedit); (3) `GtkScrollable` + adjustments. If perf is
janky, the answer is definitive: stay on GtkSourceView.

**Long lines:** adopt GtkSourceView's own posture — detect and warn/refuse
pathological single-line files rather than hang. Revisit only if real workloads
make it intolerable.

## Document-model direction (A2): own the model, keep per-view GtkSourceViews

*(Decided 2026-06-16, **implemented and merged to master** — `cdfb797`. POC in
`src/poc/document-model.ts` validated the gates first.)*

A third path between Option A (one shared buffer, emulate everything per view) and
Option C (own the whole widget): keep GtkSourceView as the **renderer**, but make
**our model the source of truth for text** and give **each view its own buffer**,
synced from the model. This is how Atom (`TextBuffer` ↔ N `TextEditor`s), VS Code
(`TextModel` ↔ editors), and CodeMirror 6 (state ↔ views) all work — and our vim
layer is a port of Atom's vim-mode-plus.

**Why it was needed: everything buffer-level renders identically in every view.**
Two `GtkTextView`s on one `GtkTextBuffer` show the *same* cursor, selection,
current line, brackets, search, and folds, because the *buffer* owns the
`TextTag`s, the `insert`/`selection_bound` marks (native caret + selection), and
the `invisible` fold tag; the *view* owns only scroll + child widgets. Per-view
folding was outright **impossible** (line visibility is a buffer tag). The fix is
to stop sharing the buffer.

**What A2 fixed (natively, per view):** caret, selection, current-line, search,
bracket, and **folding** are each native again (each buffer has its own marks/tags)
— so the v1 shared-buffer workaround (`ViewDecorations` custom-Cairo cursors,
emulated cursor marks, focus-gating) was deleted, not used. Native inline widgets /
`GtkSourceAnnotations` / markers per view became possible. LSP `didChange` fires
once from the model (no "gate to the active view" hack).

**What A2 does NOT fix** (still GtkTextView, below us): long single lines, and
native multi-cursor *within* one view (still one mark pair per buffer → extra
cursors stay emulated, but now leak-free since each view has its own buffer). So A2
is the targeted fix for **multi-view**, not a substitute for the Option C endgame —
and it doesn't preclude C later (the `Document` model layer ports unchanged; only
the views get swapped).

**Mechanics + the undo trick.** An edit in any view → apply to the model → mirror
to the other view buffers, reentrancy-guarded by an `origin`/`suppress` pair (care
around IME commit and exact `(offset, deleted, inserted)` mirroring). Undo is the
crux: native per-buffer undo would desync views, so the **headless model buffer**
holds the one native undo manager (`setEnableUndo(true)`) and view buffers have undo
**off** (`setEnableUndo(false)`); `EditorModel.setUndoTarget()` routes a
document-backed view's `undo`/`redo`/`transact` to the `Document`, which propagates
to every view. Syntax stays per-view (N parses; the model buffer isn't shown).

`Document.ts` owns the model buffer + `createView()`, file I/O, disk-watching,
modified-state, and the document-level LSP. `TextEditor` is a view onto a
`Document`; `AppWindow` split opens a real 2nd view; the live see-definition peek
(`peek: true`) is a read-only 2nd view. Verified in-app + 576 tests.

**Deferred polish (not blockers):** undo grouping feel (relies on GTK's native
coalescing; wrap vim ops in `beginUserAction`/`endUserAction` if needed); IME under
heavy multi-view load (not stress-tested); extreme pastes (fuzz-tested, not at
pathological scale); linked scroll for split (panes scroll independently by
default); double parse (N parses for N views — fine for typical 2–3).

**Still unblocked but not yet built:** the model as a single authoritative edit
stream is a foundation for collaborative editing / CRDT, model-layer AI edits, macro
recording, or history/time-travel; new view types (minimap-as-view, "compare
against unsaved") are just `Document.createView()`.

## Constraints carried from the research (cited; uncertainties flagged)

- **Single mark pair.** `GtkTextBuffer` has exactly `insert` + `selection_bound`,
  unchanged in GTK4 — no native multi-cursor or rectangular selection.
  (docs.gtk.org `class.TextBuffer`; GtkSourceView PainPoints wiki.)
- **All buffer-level state renders identically in every view of a buffer.** *(Ours,
  proven building the document registry.)* See A2 above — the clean fix is per-view
  buffers.
- **Multi-cursor is proven on top, and fragile.** GNOME Builder's `ide-cursor.c`
  (parallel mark pairs + per-cursor edit replay). GNOME Text Editor still lacks it,
  described upstream as needing "deep changes into GtkSourceView"
  (gnome-text-editor#253). *Uncertain:* GTK4-era Builder impl details.
- **Long single lines are the one unfixable wall.** Each paragraph is one
  indivisible `PangoLayout`, so a giant line defeats visible-only layout; the
  loader may refuse such files (gtk#229, gtksourceview#95/#208). Large line *counts*
  are fine. *Uncertain:* GTK4 crash status, loader thresholds, exact big-O.
  **Mitigated (long-line guard):** on load, a file with any line ≥ `LONG_LINE_THRESHOLD`
  (20k chars, VS Code's `maxTokenizationLineLength` default) enters *long-line mode* —
  soft-wrap forced off (re-flowing a giant line every layout is the worst multiplier) and
  tree-sitter highlighting dropped (`disableHighlighting`; a minified line is thousands of
  tag-applies), with a toast. The file opens + scrolls instead of hanging; GtkTextView still
  renders the wide line as best it can (cairo/pixman may warn on the oversized rect — benign,
  the genuine wall). `hasLongLine`/`applySyntaxOrLongLineMode` in `TextEditor.ts`.
- **Extensibility is additive, not replaceable.** Gutter renderers, `TextTag`s,
  `snapshot_layer`, `GtkSourceAnnotations` cover gutter/inline/virtual-text needs —
  but you cannot replace the per-line Pango layout, the part owning the widget
  would be *for*.
- **Rust-in-process is realistic but not turnkey.** One libgtk + GType registry +
  main loop supports co-residency, but exporting a Rust gtk widget needs a manual
  GIR/typelib pipeline (C2 sidesteps this by keeping rendering in JS, Rust as a
  pure-logic napi core). Best blocks: `ropey`, tree-sitter; **avoid** cosmic-text
  inside GTK (redundant with Pango). *Uncertain:* no project proves "Rust core +
  GTK4 custom snapshot widget" end to end.

## Shared editor primitives (the seams features plug into)

All built (`src/ui/TextEditor/`):

- **Buffer change events** — `EditorModel.onDidChangeText` (Atom
  `{changes:[{oldRange,newRange,oldText,newText}]}` shape), backed by the buffer's
  `insert-text`/`delete-range` signals. Consumers: vim undo/redo, LSP `didChange`,
  multi-cursor edit-replay. (tests: `EditorModel.test.ts`.)
- **Viewport + pixel geometry** — `getFirstVisibleScreenRow`/
  `getLastVisibleScreenRow` and `pixelRectForBufferPosition` (widget-relative cell
  rect for anchoring popovers), realized-view-guarded with fallbacks. Consumers: LSP
  hover/code-action popovers, vim H/M/L + scroll, diff scroll-sync.
- **Inline decorations** — `TextDecorations` / `DecorationLayer` (`editor.decorations`):
  clearable named layers of `TextTag` background spans (search `highlight`,
  diff `added`/`removed`), above syntax priority. (tests: `TextDecorations.test.ts`.)
- **Drawn-underline overlay** — `UnderlineOverlay`: a transparent `Gtk.DrawingArea`
  stroking anti-aliased Cairo sine waves under buffer ranges (nicer than
  `Pango.Underline.ERROR`). Used by `DiagnosticsView` squiggles. Drawn result needs
  interactive verification.
- **Virtual text** — `VirtualText.ts` wraps native `GtkSourceAnnotations`
  (end-of-line trailing text, per view; unblocked by A2). Consumers:
  `InlayHintController`, `DiagnosticsView`. *Note:* annotations are line-anchored
  (end-of-line only); general mid-line virtual lines would still need the gap-tag +
  overlay recipe — see [virtual-lines.md](virtual-lines.md) (not built).

## Feature status

### Search — *done*

`SearchController` (incremental literal/regex over `EditorModel.scan`, decoration
highlights, next/previous, replace-current/all with regex backrefs) + `SearchBar`
(floating top-right; search+replace entries, 3-way case button, regex toggle with
inline regex highlighting; **Alt+S** case, **Alt+R** regex; Enter/Shift+Enter step,
Ctrl+Enter replace-all). Vim `/` `?` `n` `N` wired; smartcase default. Tests:
`SearchController.test.ts`. Not yet (low priority): `*`/`#` word search, history,
operator-pending search-as-motion.

### Command line (`:` ex-commands) — *WON'T DO* (2026-06-14)

Not building a vim `:` command line. Its commands are already reachable: save via
`space w`, close via `tab:close`/`pane:close`, open via `space o`, search/replace
via SearchBar. So `:w`/`:q`/`:e`/`:%s` are covered without a modal prompt.

### Multi-cursor / blockwise — *done*

Built on Option A. `getCursors()`/`getSelections()` N-element over `MarkerLayer`;
`hasMultipleCursors`/`mergeCursors`/`mergeIntersectingSelections`/`onDidAddSelection`
are real; `Selection.onDidDestroy` backs per-selection register clipboard. Entry
points: blockwise `ctrl-v`, occurrence `c o p`, persistent `ctrl-alt-↑/↓` add-cursor
(`escape` collapses). Extra carets render as reverse-video block tags (normal/visual)
and host-drawn beam carets (insert), via `EditorModel.onExtraCursors` → a caret pool
in `TextEditor.ts`. Multi-cursor ops coalesce into one undo step (`mutateSelections`
in one `transact`); insert is live-replicated to every cursor on a deferred microtask.
Tests: `blockwise.test.ts`, `multicursor.test.ts`, `occurrence.test.ts`. Edges
needing in-app verification: beam visuals + `ctrl-alt-arrow` keys; insert sessions
can undo in a couple of steps; replication covers inserts + single-line backspaces
(multi-line deletes fall back to the leave-insert replay).

### Editor / vim polish — *done*

- **Fold-aware motions** — `EditorModel.isFoldedAtBufferRow`/`unfoldBufferRow`
  delegate to `SyntaxController` via a `FoldProvider` (`setFoldProvider`); vim
  motions skip/reveal folded rows.
- **Buffer-only editor mode** — `new TextEditor({ buffer: {...} })`: no file I/O /
  LSP / line-numbers / minimap; keeps vim + syntax + search; placeholder, `getText`/
  `setText`, Ctrl+Enter → `onSubmit`. For the Git commit-message editor.
- **Column-unit reconciliation** — columns are **codepoints** (matching `GtkTextIter`
  + `lsp/position.ts`); UTF-16 holdouts fixed (`pointAtTextOffset`, `lineLength`,
  `searchWordUnderCursor`). Tree-sitter `SyntaxController.iterAt` converts web-tree-
  sitter UTF-16 cols to codepoints, gated on a per-refresh `hasAstral` check.
  *Remaining holdout:* incremental-parse edit tracking still mixes codepoint offsets
  with UTF-16 lengths — editing next to an astral char can feed a slightly-wrong edit.
- **Vim motions** — `H`/`M`/`L`, `ctrl-f/b/d/u/e/y`, flash-on-operate, **`=`/`==`
  auto-indent** (tree-sitter indent via `SyntaxController.indentLevelForRow` +
  `EditorModel.setIndentSource`, falls back to copy-line-above).
- **Matching brackets** — under/before the cursor and its pair, or the innermost
  enclosing pair when inside (`syntax/bracketMatch.ts`); ignores brackets in
  strings/comments.
- **Indent guides** — faint per-level vertical lines (`IndentGuides`, Cairo overlay);
  toggle `editor.indentGuides`.
- **Tree-sitter text objects** — `if`/`af`, `ic`/`ac`, `ia`/`aa`, via
  `SyntaxController` `functionRangeAt`/`classRangeAt`.
- **Folds query** — driven by a grammar's `folds.scm` (`@fold` captures) when present,
  else `foldTypes`; plus run-folds (consecutive imports / line comments collapse).
  `computeFoldRanges` (`syntax/folds.ts`, unit-tested).
- **JSX/HTML tags** — auto-close (`>` inserts `</name>`, `tagClose.ts`, JSX-vs-generics
  heuristic + tag-language gate) and co-rename (`tag:rename`, `SyntaxController.tagNamesAt`).
- **Inlay hints** — LSP parameter/type hints rendered end-of-line via `VirtualText`
  (`InlayHintController`, `editor.inlayHints`).

### Diff display — *done*

`DiffView` (unified) and `SideBySideDiffView` (two-column) render from synthesized
read-only buffers — alignment fillers / deleted lines are real padded lines styled
via `editor.decorations`, sidestepping GtkTextView's lack of virtual lines and
reusing the buffer-only + decoration + scroll-sync primitives. Unified collapses
unchanged runs via the editor's diff-fold method. See [diff.md](diff.md). Diff
*data* comes from the **Git** workstream; `GitGutter.ts` draws VS Code-style change
bars (in-process Myers diff of buffer↔index and index↔HEAD).

### Scrolling performance — *pass 2 done*

Scroll jank traced to **per-frame node-gtk FFI cost**, not GtkTextView layout (only
visible paragraphs lay out): on every `value-changed`, several widget-coordinate
overlays / gutter renderers re-run JS draw code that crosses the JS↔native boundary
once or more *per visible line*. The expensive draw paths, trimmed:

- **`IndentGuides.draw`** (on by default) was the worst — ~16 + `level` FFI calls per
  visible row (each line read *twice* for blank/indent state, plus a
  `bufferToWindowCoords` per indent level). Now: one batched `getText` over the
  visible block with the level math done in JS (`levelsForRange`), and **one**
  `bufferToWindowCoords` per row (each guide column stepped by `stride` in widget
  space — buffer→widget is a pure translation within a frame). Output is pixel-
  identical; ~10× fewer FFI calls/frame.
- **Line-number gutter** (`SyntaxController.lineNumberWidth`) called `getLineCount()`
  (an FFI) once *per visible line per paint* for a per-frame constant — now cached,
  refreshed by `primeLineNumbers` on edits.
- **Viewport re-highlight** (`scheduleViewportRepaint`) re-queried tree-sitter and
  re-applied tags on *every* scroll-settle; now skipped when the visible rows are
  already inside the painted band (`visibleWithinPainted`), so a scroll within the
  ±80-line margin costs nothing. The band must be `paintedWindow` (the queried
  `visibleRange` — the region every token capture was applied to), **not**
  `paintedExtent` (the capture *bounding box*, kept for `clearPainted`): a multi-line
  node — a long block comment / string / JSX — that overhangs the window stretches the
  bbox far past the fully-highlighted region, so guarding on it let the skip fire over
  lines that only had the one broad tag → **stale/missing highlighting after scrolling
  back to them** (the bug; fixed by tracking `paintedWindow`. `paintedWindow ⊆
  paintedExtent` always, so the guard is strictly more conservative — it can never skip
  a needed repaint). Confirmed with a probe: a 1000-line block comment produced 136
  over-skips under the old guard, 0 under the new.

**Pass 2 (measured first).** An in-app profiler (temporary `value-changed`-driven
synthetic scroll over an 8k-line file, since headless can't kinetic-scroll) timed the
remaining per-frame work. Findings:

- The per-frame JS cost is now **small** — IndentGuides ~8 ms/s, both gutter renderers
  ~1–3 µs/`queryData` (≈3 ms/s combined), `syntax.repaint` doesn't even fire during a
  continuous fling (the pass-1 within-band guard + the trailing debounce). Total ≲ 12 ms/s
  (~1 % CPU). **Pass 1 already captured the JS-side win.**
- The gutter **does** re-query every visible line every paint, but each call is ~2 µs
  (`setMarkup` on a tiny string) — not worth optimizing.
- A/B test (IndentGuides overlay added vs. not) showed **no change** in paint rate: the
  view repaints ~20×/s under the synthetic driver *regardless* of our overlays. So the
  frame-rate ceiling is **native GtkTextView/GSK rendering**, not our JS. (The ~20 fps is
  partly a synthetic-driver artifact — real kinetic scroll uses GTK's frame clock with
  partial redraws — so don't over-read it; the takeaway is "JS is no longer the limiter.")

So pass 2 targeted the one remaining sizeable JS item, IndentGuides' per-row geometry
(~3 FFI/row, the bulk of its ~420 µs/draw): hoist the `bufferToWindowCoords` out of the
loop (buffer→widget is one frame-constant translation) and, when every visible row is the
base height (no soft-wrap / scaled line on screen — the common case for code), derive each
row's y arithmetically with **no per-row FFI at all** (a getIterLocation-per-row fallback
covers wrapped/markdown viewports). ~420 → ~50–100 µs/draw in the common case; output
verified pixel-identical to pass 1 against the per-row ground truth under synthetic scroll.

Not pursued (measurement says low ROI / high risk): the banded native-scroll rewrite
(draw guides in a content-sized `add_overlay` surface so they don't repaint per frame) —
`snapshot_layer`/`add_overlay` still re-run per scroll frame, and the A/B test shows
IndentGuides isn't the frame-rate limiter anyway. `UnderlineOverlay` (squiggles) still
redraws per frame under diagnostics; same single-transform trick applies, marginal win.
The real remaining lever is **native rendering** — the gated custom-widget / Rust-core
path (Option C above), not more JS micro-optimization.

### Open performance — *bounded first paint*

Opening a large file froze on the **first highlight paint**: the view is realized but not
yet size-allocated, so `visibleRange()` is null and the paint covered the WHOLE buffer
(an `applyTag` per capture across every line). Measured ~840 ms at 3k lines, ~1.45 s at 8k
— it grows with file size. Fix: `initialPaintRange()` bounds that first geometry-less paint
to the top `INITIAL_PAINT_LINES` (250) — the initial viewport is the file's head — so open
is **O(viewport), ~65–78 ms regardless of file size** (11–23× faster); the normal viewport
repaints cover the rest as the view sizes / the user scrolls. A genuinely unrealized view
(headless / tests) keeps the whole-buffer paint, so tests are unaffected. *Remaining open
cost not yet addressed:* tree-sitter `preloadGrammars` + plugin activation run synchronously
before the window shows (unmeasured — see the perf audit).

## Related friction evidence

[inline-widgets.md](inline-widgets.md), [document-registry.md](document-registry.md),
[virtual-lines.md](virtual-lines.md), [decorations.md](decorations.md),
[folding.md](folding.md), [diff.md](diff.md).
