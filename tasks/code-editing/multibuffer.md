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

- **2a** Define `ViewProjection` + segment model (generalize `MultiBufferModel` + `Document`'s
  fold/sync). Coordinate map view↔`(segment, sourceOffset)`; **fold composed as a second
  transform** on top.
- **2b** Materialize + reverse-sync: build/maintain the view buffer from segments;
  re-materialize a segment's rows when its source changes.
- **2c** **Edit write-through**: view edit → `(segment, sourceOffset)` → the source model
  (which propagates back). Boundary / block-row / read-only-segment edits clamp or reject.
  *Single full-file segment = identity = today's `Document.forward`.*
- **2d** Folds as a projection transform (replace `Document.foldViewRange`'s physical-collapse
  path; merge with excerpt re-keying).
- **2e** `TextEditor` always builds a projection; normal editor = one full-file editable
  excerpt; **collapse the painter's single-source path into the one-segment case; delete the
  buffer-mode duality + the `syntaxProjection` special-casing.**
- **2f** Retarget gutter / diagnostics / inlay / decorations to the projection map (identity
  for one source); per-source line-number gutter.
- **2g** Undo seam (single source first; cross-source in Phase 3).

**Validation:** the existing single-file editor/vim/fold/diagnostics tests must stay green
with the editor running on the projection; add `ViewProjection` unit tests (coordinate math,
identity write-through, fold transform).

### Phase 3 — Multi-source editable

Stack N sources on the proven substrate.

- **3a** Multi-source write-through (edits land in the right source); selection/edit spanning
  excerpts clamps.
- **3b** **Diff duality**: a segment's source is the live `Document` (new side) or a parsed
  base blob (old side); **phantom removed rows** = read-only segments over the base blob; diff
  decorations + `foldUnchanged` via the projection; two line gutters (old|new); **live re-diff
  on edit-idle** (reuse `lineDiff` / `DiffModel`).
- **3c** **Cross-source undo** (G7): per-source stacks + a coordinated transaction for
  multi-file ops.
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
