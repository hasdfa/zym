# Multibuffer — one editable, excerpt-backed editor substrate

**End-state:** a single editor substrate where every `TextEditor` renders a *projection* over
an ordered list of **excerpts** (each a source + a range), with one cursor and continuous
scroll. A normal file is the degenerate case — one full-file excerpt. Stitched ranges from
**many files** appear with filename headers, each highlighted by its own grammar, editable,
writing through to the files. The forcing function is the multi-file diff/search surface
(replacing `GitStagingView`'s accordion and powering project-wide search-replace +
refactors) — like Zed's project-search / project-diff "multibuffer" or GitHub's "Files
changed", but editable and per-language-correct.

**Working agreement:** we build this to completion, **hard parts first**. The editor has no
users, so the single-file editor's existing behavior + the headless test suite are the
regression net. No incremental-shipping detours — in particular **no read-only-diff
intermediate**; the unified substrate is built first so every surface is editable from birth.

## End-goals

The work is done when all of these hold:

- **G1 — One substrate.** Every `TextEditor` renders a `ViewProjection` over an excerpt list;
  a normal file = one full-file excerpt. No "normal editor vs multibuffer" duality.
- **G2 — Editable everywhere** via write-through to source `Document`s (single-file =
  identity; multi-file refactors + replace-all work).
- **G3 — Folds are a transform** in the same coordinate stack, not a `Document`-specific
  mechanism.
- **G4 — Per-source-correct everything** in one coordinate space: highlighting (done),
  line-number gutter, diagnostics/LSP, decorations.
- **G5 — Continuous multi-file editable diff** (old/new duality, phantom removed rows, live
  re-diff, fold-unchanged) replacing `GitStagingView`.
- **G6 — Editable project search + replace-all** across files as one transaction.
- **G7 — Cross-source undo/redo** policy.
- **G8 — Multibuffer-correct interaction**: vim motions, selection/edit boundary clamping,
  copy strips header/gap rows, jump-to-source, per-excerpt collapse.
- **G9 — Multiple diff sources** (working-tree/HEAD, commit, PR, range) feeding one surface.
- **G10 — Performance**: virtualized across many excerpts; zero-cost identity for single-file.
- **G11 — Session persistence** of multibuffer tabs.

## Why this shape (projection, not a stack of editors)

Zed never concatenates text into one real buffer conceptually — it keeps N real buffers (each
its own language/parse/LSP) and presents **excerpts** (a buffer + a range) as one virtual
coordinate space; headers are non-text **blocks**; the renderer paints only visible rows;
edits write through. We build the equivalent on GtkSourceView because the scaffolding already
exists — this is a **generalization of shipped patterns**, not greenfield:

- **`Document` / `DocumentRegistry`** = ref-counted real buffers, N views per Document — Zed's
  "real buffer behind excerpts."
- **Fold projection** already proves the view `GtkSource.Buffer` is a **projection** of the
  model with bidirectional view↔model translation. A fold hides ranges of *one* Document; a
  multibuffer concatenates slices of *many*. **They are the same mechanism** — the unification
  (Phase 2) makes that literal.
- **Synthesized rows** — fold placeholders and side-by-side fillers are already real, styled
  buffer lines. Filename headers are the same trick.
- **Virtualization is not a blocker.** GtkTextView validates lines around the viewport itself,
  and the painter paints only the visible range.

**The GtkSourceView reality:** unlike Zed's custom renderer, GtkTextView requires the
displayed text to live in a real `GtkTextBuffer`. So the view buffer is a **materialized
projection** of its source(s) — for a single file with folds it's already exactly that
(folds physically rewrite the view buffer today). The multibuffer generalizes "the view
buffer is a materialized projection" from {one Document, folds} to {N Documents, excerpts +
folds}.

## Architecture (target)

Three layers:

- **Source** — `Document` reduced to: the headless model buffer + its shared `DocumentSyntax`
  parse + the LSP document + file I/O. *No view buffers, no fold logic* (those move up).
- **`ViewProjection`** (per view) — the ordered `Segment[]` + block rows; the coordinate map
  view↔`(segment, sourceOffset)` with **folds composed as a second transform**; materializes
  + reverse-syncs the view `GtkSource.Buffer`; routes edits back to the right source
  (write-through). Generalizes today's `Document` fold/sync logic + `MultiBufferModel`.
- **Painter** — `SyntaxController` paints the view buffer from each segment's source
  `DocumentSyntax` captures through a `SyntaxProjection` (already pluggable, Phase 0/1).

```
segment = { source, range, editable: boolean, kind: 'real' | 'phantom' }
```

- `source` = a parsed text unit: a `Document` (live/new side) or a parsed blob (old/base
  side). The painter highlights each segment from its source's own captures → per-language
  correct, and (for diffs) the old side parsed with the *same grammar* but separate content.
- **Editable diff = the new `Document` is the substrate; the diff is a projection over it.**
  Context + added lines are `editable`/`real` mapped to the new `Document` (write-through is
  normal editing). **Removed lines are real view rows tagged read-only** (`kind: 'phantom'`,
  mapped to the old blob) — *not* EOL virtual text. The diff (phantom rows + backgrounds) is
  re-computed on edit-idle against the base blob (reusing `lineDiff`); editing stays normal
  file editing, the diff re-segments as you type.

---

## Phases

The old "1b read-only diff → 2 editable → later unify" ordering is dropped. We unify the
substrate **first** (Phase 2, hardest), validated against the single-file editor, then the
diff/search surfaces are editable consumers of it.

### Phase 0 — Parse/paint split — ✅ DONE

`SyntaxController` (per view) was split; the parse moved to `src/syntax/DocumentSyntax.ts`
(per `Document`, shared by all its views).

- **`DocumentSyntax(sourceBuffer)`** owns the tree-sitter `Tree`, injection parsers,
  incremental reparse (debounced 60ms off the source buffer's `insert-text`/`delete-range`/
  `changed`), fold-region **discovery** (`foldRanges()`), and the tree queries
  (`captures(fromLine,toLine)`, `isInStringOrComment`/`indentLevelForRow`/`functionRangeAt`/
  `classRangeAt`/`tagNamesAt`/`captureCounts`) — **all in model coordinates**.
  `onDidReparse(cb)` fans out to painters; `setLanguageForPath` is idempotent (a sibling view
  reuses the tree; a reload reparses via a `dirty` flag).
- **`Document`** owns one `DocumentSyntax` lazily (`get syntax()`), disposed with it.
- **`SyntaxController`** is the per-view *painter*: it pulls model-coord captures + fold
  ranges and translates them into its view (identity unless the view has collapsed folds),
  keeping the per-buffer `HighlightTags`, fold/placeholder/bracket tags, composite gutter,
  persistent paint cache, and per-view fold **state**. It paints through a pluggable
  **`SyntaxProjection`** (`src/syntax/SyntaxProjection.ts`): with one it paints many sources'
  slices (multibuffer), without one it paints its single `docSyntax` through the fold map.
  Public `paint()` triggers a projection view's first paint.

Fell out of parsing the model: folds never touch it, so its tree stays valid through a fold —
the `fullReparseNext` fold-drift hack and the `include_hidden_chars` parse hack are gone.

Known Phase-0 limitation: a discovered fold and a collapsed fold mapping to the same view
line → the collapsed fold wins that gutter slot (required now the model parse rediscovers
collapsed bodies). Folded + astral over a shared model walks `viewPointFromModel`.

Tests: `DocumentSyntax.test.ts` (one parse paints N view buffers; an edit through one view
reparses + repaints both).

### Phase 1 — Excerpt model + multi-source projection — ✅ DONE

Validated the coordinate map + per-grammar projection painting everything below rests on. Its
read-only nature is temporary (Phase 2 makes it editable); its model code is reused.

- **`MultiBufferModel.ts`** — pure substrate, no GTK. `Segment { sourceKey, startRow, endRow,
  editable, kind }` + `Excerpt { header, segments }`; `MultiBufferProjection.build` → the
  concatenated text (header / segment / `⋯` gap / blank rows) + a sorted `RowEntry[]`
  coordinate map (binary-search `entryAt`/`sourceAt`/`viewRowForSource`/`segmentsInViewRange`/
  `isEditable`).
- **`ExcerptSyntaxProjection.ts`** — implements `SyntaxProjection` from a projection +
  `Map<sourceKey, DocumentSyntax>`; builds `mb:header`/`mb:gap` tags in `decorate`.
- **`MultiBufferView.ts`** — a thin wrapper: resolve each source (bare buffer +
  `DocumentSyntax`, read-only disk snapshot), build the projection, create a
  `TextEditor` (buffer mode, `readOnly`, `syntaxProjection`) — so it's a real editor (vim,
  search, decorations for free) — and wire Enter / double-click → `(path, row)` → `onActivate`.
- **`projectSearch.ts`** — `runProjectSearch` (rg --json grouped by file) + pure
  `matchesToExcerptInputs` (context-pad + merge regions). Wired to
  `AppWindow.openSearchMultibuffer` / `project:search-multibuffer` (`space *`): search the
  active editor's selection → results as a multibuffer tab. Disposed via `disposeChild`.

Tests: `MultiBufferModel.test.ts`, `MultiBuffer.test.ts` (painter in projection mode paints
translated rows from each own parse; ts-vs-json proves per-grammar), `projectSearch.test.ts`.
Runtime smoke drove rg → excerpts → a real `TextEditor` multibuffer → navigation.

### Phase 2 — Unified `ViewProjection` substrate (single-file first) — KEYSTONE, hardest

Collapse the two mechanisms (Document fold/sync + excerpt model) into one per-view
`ViewProjection`; `Document` shrinks to "a source." Single-file editor first, because its
existing behavior + ~700 tests are the regression invariant — prove the substrate on
known-good behavior before any multi-source complexity.

- **2a — ✅ DONE.** `src/ui/TextEditor/ViewProjection.ts` — the pure, GTK-free coordinate
  substrate. Models a view as an ordered `Item[]` (`segment`s over sources + synthesized
  `block` rows: header/gap/blank) and maps the three spaces **source `(sourceKey,row,col)`
  ↔ projection ↔ view** with **folds composed as a second transform** (collapsed projection
  offset ranges → placeholders). A single full-file segment with no folds is `isIdentity`
  and every translation short-circuits (zero-cost single-file path; hard problem #6). Offsets
  are codepoint-counted (matches GtkTextBuffer iters). Public API: `build(items, resolveLines)`,
  `viewText`/`projectionText`/`viewRowCount`, `viewToSource`/`sourceToView`/`sourceRowAtViewRow`/
  `viewRowForSource`/`projectionRowForSource`, `addFold`/`removeFold`/`clearFolds`/`foldSpans`,
  `isViewPositionEditable`/`isViewRangeEditable` (gates blocks/phantoms/cross-source/folded —
  hard problem #1), `blockRows()`. Generalizes `MultiBufferModel` (not yet retired — 2e
  migrates the multibuffer onto this). Tests: `ViewProjection.test.ts` (identity, multi-source
  map, fold transform, fold∘multi-source composition, editability, astral codepoint offsets).
- **2b — ✅ DONE.** `src/ui/TextEditor/ProjectionView.ts` — the per-view materialize +
  reverse-sync layer over a `ViewProjection`. Owns ONE view `GtkSource.Buffer`, built from
  `viewText`; **reverse-sync (source → view)** mirrors a source-buffer change into the view at
  its projected location. Identity (single full-file source): a 1:1 incremental mirror —
  byte-for-byte today's `Document.propagate` — robust to row-count changes (identity
  translation is independent of the grown segment). Non-identity (multi-source read): coarse
  re-materialize on a microtask once the source settles (the precise minimal-splice is a
  Phase-4 perf/cursor refinement). Tests in `ProjectionView.test.ts`.
- **2c — ✅ DONE (single-file scope).** **Write-through (view → source)** in the same
  `ProjectionView`: a view edit → `viewToSource(row,col)` → the right source buffer
  (suppressed so reverse-sync doesn't echo). Single full-file segment = identity = today's
  `Document.forward` (proven by a 500-edit both-directions fuzz vs the Document contract).
  Block / phantom rows carry a non-editable `vp:readonly` TextTag so the user can't type
  there, and write-through rejects any edit not landing on a single editable real segment
  (boundary clamp). Multi-source *editable* write-through (row-count-changing edits
  re-segmenting the projection live) is **Phase 3a**.
- **2d — ✅ DONE.** Folds as the analytic transform in `ProjectionView` (+ `ViewProjection`).
  `fold(viewStart, viewEnd, placeholder)` / `unfold(handle)` collapse/restore the view buffer
  (source untouched, placeholder read-only-tagged, inner folds subsumed). Fold handles are
  `ViewProjection.Fold` objects whose offsets are **shifted analytically on every source edit**
  (`shiftFoldsForInsert`/`shiftFoldsForDelete` = left-gravity start / right-gravity end, the
  marks Document used) so a single-file view stays incrementally synced WITH folds (no
  re-segment). Edits a fold absorbs don't touch the view. Also added the full **`FoldHost`
  translation surface** (`modelLineForViewLine`/`viewLineForModelLine`/`modelPointFromView`/
  `viewPointFromModel`/`modelLineText`/`foldPlaceholderRange`/`foldModelText`/`isFoldAlive`),
  so `ProjectionView` is a drop-in for what `Document` gives `SyntaxController`. Validated
  against `Document.test.ts`'s fold contract incl. a **600-edit fold fuzz** (collapsed-view
  invariant checked every iteration) + nested-fold subsumption + absorbed edits.

> **Substrate complete + proven (standalone, headless).** 2a–2d landed as new modules
> (`ViewProjection.ts` + 8 tests, `ProjectionView.ts` + 17 tests), the full suite green (745,
> +25) and typecheck clean — nothing in the live editor touched yet. 2e wires it in (the
> invasive swap).

- **2e — ✅ DONE (core wiring).** `Document` now creates a **`ProjectionView` per view** over
  its model (one full-file editable segment) instead of a hand-synced `ViewEntry`: `forward`/
  `propagate` + the mark-based fold machinery (`toModelOffset`/`toViewOffset`/`foldViewRange`/
  …) are GONE; the model's signal handler only fires LSP `didChange`; each view's PV self-syncs
  (write-through + reverse-sync) and owns its folds. `Document` keeps its **public API**
  (`createView`/`removeView`/`foldViewRange`/`modelPointFromView`/`modelLineForViewLine`/… +
  undo + `setText`) by **forwarding to the view's PV**, so `SyntaxController` (the `FoldHost`),
  `TextEditor`, `EditorModel`, and `GitGutter` are untouched. `setText` suspends PV sync, bulk-
  replaces the model, then `rebuild`s each PV (clearing folds). Validated against the full
  editor suite (745 green) incl. `Document.test.ts` (cross-view sync + 600-edit fold fuzz) and
  `EditorModel.test.ts`. **Bug fixed during wiring:** `foldPlaceholderRange` must report a
  zero-width range for a just-removed fold (the old marks collapsed) — else the cursor-snap in
  `onCursorMoved`, firing during `unfold`'s splice while the fold-access still reports the
  placeholder, span-looped forever.
  **Two fold bugs found in GUI testing + fixed (`foldAll.test.ts` guards them):** (a) `zM`
  was O(folds²) (10.5s on a 564-line file) and produced wrong nested folds — it drove folds
  from stale view-line snapshots, so an outer fold ate past its footer once inner folds had
  collapsed. Rewrote `SyntaxController.foldAll` to drive from MODEL fold ranges (stable),
  outermost-first, translating each to its CURRENT view lines just before folding + skipping
  subsumed ranges, and to batch the re-key/repaint to once → **96ms, correct**. (b) `zR`
  (`unfoldAll`) didn't repaint, so a restored body — spliced between the `{`/`}` punctuation —
  inherited the punctuation tag and rendered in the delimiter color; `unfoldAll` now re-keys
  + repaints (single `zo` via `toggleFold` already did).
  *Deferred (couples to the multibuffer migration, Phase 3a/4, not single-file behavior):*
  collapsing the painter's single-source path into the one-segment case, and deleting the
  buffer-mode / `syntaxProjection` duality (MultiBufferView still uses its own path).
- **2f — ✅ DONE for single-source (via 2e delegation).** Gutter / diagnostics / inlay /
  decorations already translate through `Document.modelLineForViewLine`/`viewLineForModelLine`/
  `viewPointFromModel`/`modelPointFromView`, which now delegate to the PV (identity for one
  source, fold-aware otherwise) — green across the suite. *Per-source line-number gutter is a
  multi-source concern (Phase 3b: two gutters old|new).* 
- **2g — ✅ DONE for single-source.** Undo stays model-owned: `Document.undo` → `model.undo` →
  model signals → every view's PV reverse-syncs (`Document.test.ts` undo/redo-propagate green).
  *Cross-source / multi-file-transaction undo is Phase 3c.*

> **Phase 2 core milestone reached:** every normal-file `TextEditor` renders a `ViewProjection`
> (one full-file excerpt) — the single substrate (G1, single-file scope) is live and proven.
> What remains for *full* G1 is migrating the multibuffer + buffer-only editors onto the same
> substrate (folds into Phase 3a/4).

**Validation:** the existing single-file editor/vim/fold/diagnostics tests must stay green
with the editor running on the projection; add `ViewProjection` unit tests (coordinate math,
identity write-through, fold transform).

### Phase 3 — Multi-source editable

Stack N sources on the proven substrate.

- **3a — write-through mechanism ✅ DONE; coordinate unification ✅ DONE; live-source wiring
  NEXT.**
  - *Write-through mechanism:* `ProjectionView` routes a multi-source view edit to the edited
    segment's source (`viewToSource` → that source buffer), and **clamps** — an edit on a block
    / phantom row, or a delete spanning two segments/sources, is rejected (hard problem #1).
    `ViewProjection.viewToSource` gained a no-fold **row-direct** fast path (translate by
    `rowInfo` index, not the edit-stale offset table) so **in-place edits need no remap**.
    Tests in `ProjectionView.test.ts`.
  - *Coordinate unification:* `MultiBufferView` + `ExcerptSyntaxProjection` now run on the
    unified `ViewProjection` (via `excerptsToItems` + `ViewProjection.segmentRunsInViewRange` /
    `blockRows` / `viewToSource`); the duplicate `MultiBufferProjection` coordinate class is
    **retired** (`MultiBufferModel.ts` is now just the excerpt→`Item[]` layout).
  - *ProjectionView-backed (the TextEditor seam):* `MultiBufferView` now backs its editor with
    a real **`ProjectionView`** over the source buffers — the same substrate the single-file
    editor uses. `TextEditor` gained a minimal `buffer.externalBuffer` option: a buffer-mode
    editor uses the supplied PV buffer instead of creating its own, leaving the single-file
    `Document` path **100% unchanged** (the scratch `Document` is a harmless identity shim).
    Read-only behavior unchanged; PV path tested in `MultiBuffer.test.ts` (materialize + paint +
    navigation). Suite 749 green. So the multibuffer's view buffer *is* a `ProjectionView` now.
    **Highlight-bleed bug fixed (GUI testing):** a multi-row capture (e.g. a block/doc comment)
    extending beyond an excerpt would, when applied across the stitched view buffer, bleed its
    tag into *later* excerpts (a code line showing comment-colored). `SyntaxController.sliceIter`
    now clamps each capture to its slice's `[fromRow, toRow]` span. Guarded by `MultiBuffer.test.ts`.
    **Read-only enforcement fixed (GUI testing):** the multibuffer (and diff panes / peek) set
    `readOnly`, but that only did `view.setEditable(false)` — which vim's per-mode
    `setInputEnabled` re-enables on insert, and which normal-mode operators (`x`/`dd`/`p`) bypass
    by mutating through `setTextInBufferRange`. So results were editable (and "undo didn't work"
    because the view buffer's edits had no undo target). `EditorModel.setReadOnly` now gates the
    edit funnel + keeps input disabled regardless of mode; `TextEditor` calls it for `readOnly`
    buffer mode + peek. Guarded by `EditorModel.test.ts`.
  - *Remaining:* (1) source from **live `Document`s** (registry-ref'd) instead of disk
    snapshots → live re-projection; (2) flip read-only off → editable (the PV write-through
    already routes to sources); (3) **cross-source undo (3c)** to make editing coherent.
    Together these finish G1 (delete the buffer-mode / `syntaxProjection` duality).
    *Row-count-changing multi-source edits (re-segmentation) remain Phase 3b.*
- **3b — model ✅ DONE; read-only surface ✅ BUILT (GUI-untested).** `src/ui/multibuffer/
  diffMultiBuffer.ts`: `buildDiffMultiBuffer(files)` assembles N changed files into the
  `ViewProjection` item list (header + diff segments per file) + a per-projection-row
  `DiffRowKind[]` + the source line arrays (4 tests). `src/ui/multibuffer/
  DiffMultiBufferView.ts`: a read-only continuous multi-file diff — `ProjectionView` over the
  new/old source buffers, painted per-side by `ExcerptSyntaxProjection`, added/removed
  backgrounds from `rowKinds` via `applyDiffDecorations`, Enter/double-click → jump to file.
  Wired in `AppWindow` (`git:diff-multibuffer`, `space g D`): async-fetches HEAD blobs
  (`git(root, ['show', 'HEAD:<rel>'])`) + working text for every `getFileStatuses()` path.
  Additive — does NOT replace `GitStagingView` yet. **Unchanged context is elided** (windowed
  like a real diff: changed hunks + `CONTEXT` lines, long unchanged runs → a `⋯ N unchanged
  lines` gap row) — `diffSegments` was refactored to expose `diffRows` (per-row op + old/new
  line indices) + `rowsToItems`, and `buildDiffMultiBuffer` windows each file. **Remaining:**
  GUI verification; expandable elided gaps (currently fixed). It is **READ-ONLY** —
  `space g D`: each changed file's hunks (+ context, long unchanged runs elided to `⋯`),
  per-side syntax highlighting, added/removed backgrounds, old|new line gutters
  (`buildDiffMultiBuffer` emits per-row `oldNums`/`newNums` from `diffRows`), jump-to-source.
  NEW side = the file's current text (open document's live text incl. unsaved edits, else
  disk); OLD side = the HEAD blob.
  **Highlight-bleed fix (GUI):** the new side wasn't highlighted unless language-set — fixed
  by parsing each side's bare buffer; the painter reads the LIVE projection via a
  `() => ViewProjection` getter (so a future re-materialize can't leave it stale).
  **EDITABLE diff — substrate PROVEN, surface DEFERRED.** The mechanism works at the substrate
  level (`diffEditable.test.ts`: new-side write-through to a live `Document` + phantom-old
  rejection + PV-coordinated undo; seams `Document.modelBuffer`, `TextEditor.buffer.undoTarget`,
  `EditorModel.setEditableCheck`). But a first editable WIRING (live Documents + re-diff +
  save) hit a wall in GUI testing: editing a continuous diff smoothly needs **incremental
  re-segmentation** (splice only the edited file's rows + preserve cursor/decorations) — the
  whole-buffer re-materialize shortcut flashes + jumps the caret on every line add/remove and
  on undo (reverse-sync rebuild), and the per-row edit gate leaked through some vim paths
  (`cc` on a removed line corrupted the line above). So the surface was reverted to read-only;
  editable is a dedicated follow-up = incremental re-materialize (reverse-sync minimal-splice +
  decoration/cursor preservation) + bulletproof per-row edit gating, then it replaces
  `GitStagingView` (G5).
- **3b — segment model ✅ DONE.** `src/ui/multibuffer/diffSegments.ts`: `diffSegments(old,
  new, newKey, oldKey)` line-diffs (reusing `lineDiff`) and emits `ViewProjection` items —
  `eq`/`ins` → editable `real` rows over the NEW source (context + added), `del` → read-only
  `phantom` rows over the OLD blob (removed) — plus the per-row `ops` for decorations /
  fold-unchanged. So editing a diff = normal editing of the new document (write-through);
  removed lines are real non-editable view rows over the base, not EOL virtual text. Tested
  (`diffSegments.test.ts`) incl. composed with `ViewProjection` (interleave + editability
  gating). *Remaining 3b (surface, GUI-coupled):* live re-diff on edit-idle, diff
  decorations (added/removed backgrounds), `foldUnchanged` (fold the `eq` segments — just the
  fold transform), two line gutters (old|new), over a live `Document` new-side + base blob.
- **3c — mechanism ✅ DONE.** `ProjectionView` is now an `UndoTarget` coordinating its sources:
  each user action is a **transaction** recording which source keys it touched (opening each
  source's native undo group on first touch); `undo`/`redo` replay those sources' own undo in
  reverse **as one step**, so a multi-file edit (replace-all) is a single Ctrl-Z (G7). Paired
  with **multi-source in-place reverse-sync** (3a): an external / undo edit to a source now
  mirrors into the multibuffer view at its translated row (cursor preserved) via the no-fold
  row-direct `sourceToView`, rather than a coarse rebuild (row-count-changing edits still
  rebuild → Phase 3b). Tests in `ProjectionView.test.ts` (route+undo on the right source;
  multi-file transaction undone as one step; in-place reverse-sync). *Remaining to ship: wire
  the PV as the multibuffer editor's undo target (TextEditor) once it's editable.*
- **3d** **Editable project search → replace-all** (G6): edit results in place (write-through);
  replace-all across files as one undo transaction; powers multi-file refactors.

### Phase 4 — Surfaces, interaction, polish (remaining goals)

- **Replace `GitStagingView`** with the editable diff multibuffer (G5 — the forcing function).
- **More diff sources** (G9): commit / PR / arbitrary range.
- **Multibuffer interaction** (G8): vim motions respecting excerpt/header/phantom boundaries;
  copy strips header/gap rows; jump-to-source; per-excerpt collapse (excerpt folding as
  another transform).
- **LSP across excerpts**: rename / code-action spanning files via the `WorkspaceEdit` applier.
- **Performance** (G10): viewport virtualization across many excerpts; a sum-tree coordinate
  map only if profiling demands it (>thousands of excerpts); confirm single-file identity stays
  zero-cost.
- **Session persistence** (G11): serialize/restore multibuffer tabs (search query / diff
  source + excerpts).

---

## Hard problems (where the risk lives, mostly Phase 2–3)

1. **Editing near boundaries.** One full-file segment, no folds = identity (safe). Edits on
   block rows, across excerpt boundaries, or spanning a fold must clamp or reject.
2. **Undo/redo across sources.** A multibuffer touching N sources needs a policy: per-source
   stacks, or a coordinated transaction spanning sources (a multi-file refactor = one undo
   step). One segment = identity (today's model-owned undo).
3. **Folds: physical vs transform.** Today folds physically rewrite the view buffer; the
   excerpt map re-keys analytically. Unifying picks one: re-materialize without hidden rows
   (consistent; rebuilds buffer regions on toggle) vs an invisible-tag transform (the approach
   the fold work moved away from). Merge `Document`'s fold marks with the excerpt re-keying.
4. **Per-source decorations.** Diagnostics/inlay/git-gutter key off one Document today; in a
   multibuffer each excerpt's come from its own source and place through the unified map
   (`DiagnosticsView`, `InlayHintController`, `GitGutter`).
5. **Per-source gutter.** Line numbers show each file's real numbers; `GutterRenderer`'s
   `modelLineFor` generalizes to "source line at view row".
6. **Zero-cost single-file path.** The one-segment / no-block / no-fold case MUST short-circuit
   the map (identity) so normal editing/painting has no per-edit/per-paint overhead — the same
   "identity unless folds" discipline Phase 0 established.
7. **`Document` refactor.** Moving view/sync/fold out of `Document` is invasive; the normal
   editor's behavior is the regression invariant.

## Correctness notes

- A selection or edit spanning an excerpt boundary, or landing on a phantom/read-only row,
  must clamp or reject.
- Copy should strip header / gap rows.

## Key existing code to reuse

- Projection / translation: `src/syntax/syntax-controller.ts` (`SyntaxProjection` path,
  `repaint`/`visibleRange`, fold translation), `Document.modelLineForViewLine` /
  `viewLineForModelLine` / `modelPointFromView` / `viewPointFromModel` / `foldViewRange`.
- Model: `src/ui/TextEditor/Document.ts`, `DocumentRegistry.ts`,
  `src/syntax/DocumentSyntax.ts`, `src/ui/multibuffer/MultiBufferModel.ts`.
- Diff: `src/util/DiffModel.ts` (`computeDiff`, `foldUnchanged`, `diffBufferText`),
  `src/util/lineDiff.ts`, `src/ui/TextEditor/DiffView.ts` / `DiffViewer.ts` / `DiffGutter.ts` /
  `applyDiffDecorations.ts`.
- Search: `src/ui/multibuffer/projectSearch.ts`, `src/ui/SearchPicker.ts`.
- LSP edits: `src/lsp/workspaceEdit.ts` (`applyTextEdits` / `normalizeWorkspaceEdit`).
- Consumer to replace: `src/ui/GitStagingView.ts`.
