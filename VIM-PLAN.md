# Plan: unify editor coordinate vocabulary, make `buffer ↔ screen` real

**Spec:** [docs/text-editor/coordinates.md](docs/text-editor/coordinates.md) is
the source of truth for the `document` / `buffer` / `screen` vocabulary and the
two deliberate inversions. Read it first; this plan only sequences the work.

## Goal

One coordinate vocabulary across the editor stack, and a `buffer ↔ screen`
transform that is actually fold- (and eventually wrap-) aware instead of the
identity stubs that exist today. The vendored vim layer
(`src/ui/TextEditor/vim/*`, ported from vim-mode-plus) keeps Atom's
`buffer`/`screen` method names unchanged — the point is to make those names mean
what Atom means, not to rewrite the ported code.

## Handoff status

- **Stage 1 is DONE and merged to `master`** (rename commit `22fc09e`, merge
  `7bf6969`). It was rename-only; typecheck + the full test suite were green.
- **Stage 2 (folds) is DONE** on branch `feat/buffer-screen-transform`.
  `EditorModel`/`Cursor` now speak `buffer` and delegate `buffer ↔ screen` to the
  real fold transform; **decision recorded: vim operates on `buffer`** (unfolded,
  Atom-faithful). Gated to single-document editors with an identity no-fold path,
  so the full suite is unchanged (1024 pass / 2 pre-existing display-only failures
  / 2 skips, identical to master in this headless env) plus new fold-active tests
  in `EditorModel.test.ts` + `syntax/foldAll.test.ts`. Two GUI-found fold-provider
  bugs (`zo` caret, `5j` trap) are fixed. Soft-wrap into `screen` Points is **not**
  done (Stage 3). See [docs/text-editor/coordinates.md](docs/text-editor/coordinates.md)
  → Current state for the mechanics.
- **Next agent:** Stage 3 (soft-wrap, below) is the remaining coordinate thread;
  the parallel vim `as any` track is independent and lower-risk if you want a
  self-contained, fully-test-gated task instead.

## Current state (after Stage 1)

- `ViewProjection` (`src/ui/TextEditor/ViewProjection.ts`, pure, unit-tested)
  implements the real 3-space coordinate map under the **canonical** names
  `document` / `buffer` / `screen`. The `FoldHost` contract
  (`src/syntax/syntax-controller.ts`) + its `Document`/`ProjectionView` impls +
  `SyntaxController`'s internal translators all speak `document` / `screen`
  (`documentToScreen` / `screenToDocument` / `documentLineForScreenLine` / …).
- ✅ **Stage 2 done (folds):** `EditorModel` / `Cursor` speak `buffer`; the
  `*ForScreenPosition` / `*ForScreenRow` methods delegate to the real fold
  transform (via the single-document `FoldAccess`). The vim layer now sees the
  unfolded source through `buffer`-space reads and folds down through the `screen`
  methods. Still identity under wrap (Stage 3) and for multibuffer/buffer-only.
- Soft-wrap is real (GtkSourceView renders it; a "long-line mode" disables it)
  but lives only in pixel geometry (`gj`/`gk` via `displayLineMove`), not in the
  Point-based screen coordinates. (Stage 3.)
- Baseline is green: `pnpm run typecheck` clean, `pnpm run test` 1006 pass
  (2 pre-existing skips).

## Stage 1 — rename the projection layer to the canonical names (no behavior change) — ✅ DONE

Pure mechanical rename, gated by the test suite. Applied the map from
coordinates.md (`source`/`model` → `document`, `projection`/`proj` → `buffer`,
`view` → `screen`) to:

- `ViewProjection.ts` + `ViewProjection.test.ts`: the `Segment` fields, the three
  spaces, and the transform methods (`sourceToView`, `viewToSource`,
  `projOffsetToView`, `viewOffsetToProj`, …).
- `ProjectionView.ts` and the `FoldHost` interface + its `SyntaxController`
  implementation (`modelPointFromView`, `viewPointFromModel`,
  `modelLineForViewLine`, `viewLineForModelLine`, `modelLineText`, …).
- The prose in `docs/text-editor/multibuffer.md` and
  `docs/text-editor/folding.md` (they still say source/projection/view + model).

**Gate:** `pnpm run typecheck` + `pnpm run test` green. No behavior change — this
is rename-only; if a diff changes logic, it's wrong.

**Outcome (decisions made during the rename):**
- The class/file names `ViewProjection` / `ProjectionView` were **kept** (they
  name the substrate components; the rename targeted the coordinate *vocabulary*
  inside them — spaces, fields, transform method names — not the type names).
- `ViewProjection.ts` was made fully canonical (identifiers + prose); only GTK
  storage terms (`view buffer`, `per-view`) remain, which are correct.
- The `FoldHost` contract + its `Document`/`ProjectionView` impls + the
  `SyntaxController` internal translators are renamed; `SyntaxController`'s GTK
  widget field `this.view` and viewport-paint helpers (`paintViewLines`,
  `visibleRange`) are deliberately untouched (widget concerns, not coordinates).
- `Segment.documentKey` (was `sourceKey`) was renamed repo-wide; the block-decoration
  anchor type (`{ documentKey?, row } | { viewRow }`) inherited it. Its `{ viewRow }`
  variant (decoration layer) is out of Stage-1 scope and left as-is.
- `docs/text-editor/folding.md` has pre-existing architectural staleness
  (`forward`/`propagate`/`toModelOffset`, mark-based folds) predating the
  ViewProjection refactor — only its vocabulary + renamed-method refs were
  updated here; a full rewrite is a separate doc task.

## Stage 2 — make `EditorModel` speak `buffer`, delegate `buffer ↔ screen` — ✅ DONE

`EditorModel`'s buffer-coordinate API now operates in `buffer` space (the unfolded
source), and its `screen` methods delegate to the `buffer ↔ screen` fold transform,
so the distinction is real when a fold is active.

**Decision (documented in coordinates.md): vim motions operate on `buffer`**
(unfolded, Atom-faithful). The ported callers assume Atom's `*BufferPosition` =
unfolded text (e.g. `getVimEofScreenPosition = screenPositionForBufferPosition(
getVimEofBufferPosition(...))`), so making the conversions real *requires* the
buffer-space API to mean unfolded — there is no consistent "vim on screen" middle
ground (it would collapse the conversions back to identity).

**What landed:**
- The `screen` conversion methods (`screenPositionForBufferPosition` /
  `bufferPositionForScreenPosition` / `screenRowForBufferRow` /
  `bufferRowForScreenRow` / `clipScreenPosition` / the `screen↔buffer` ranges /
  `getCursorScreenPosition`, and `Cursor.get/setScreenPosition` +
  `getScreenRow`/`getScreenColumn`) delegate to the fold transform.
- The buffer-space **position bridge** (`iterAtPoint`/`pointAtIter`) translates
  `buffer ↔ screen`; a new `screenIterAtPoint` keeps the raw screen bridge for the
  genuine screen callers (`pixelPositionForScreenPosition`, `clipScreenPosition`,
  `scrollToScreenPosition`).
- The buffer-space **content reads** (`getText` / `getTextInBufferRange` /
  `lineTextForBufferRow` / `lineLength` / `getLineCount` / `getLastBufferRow` /
  `getEofBufferPosition` / `bufferRangeForBufferRow`) read the headless document
  (the unfolded source) when a single-document fold projection is present.
- `FoldAccess` extended with the missing translators (`documentPointFromScreen`,
  `documentLineForScreenLine`, `screenLineForDocumentLine`, `documentLineCount`,
  `documentTextInRange`, `documentText`), wired from `Document`; `FoldHost` gained
  `documentLineCount`/`documentTextInRange` (impl on `Document` +
  `MultiBufferDocument`).
- **Gating:** all of the above route through `EditorModel.foldProjection`, which is
  the single-document `FoldAccess` only — **null for multibuffer** (`buffer ==
  screen`, folding off) and **buffer-only editors**, and **identity when no fold is
  active**. So the no-fold path is byte-for-byte unchanged; only single-file +
  active-fold behavior changes.

**Gate met:** `pnpm run typecheck` clean; full suite identical to master (1024
pass / 2 pre-existing display-only failures in headless / 2 skips) plus new
fold-active tests in `EditorModel.test.ts` + `syntax/foldAll.test.ts`. Manual
vim-with-folds verification on a real display surfaced two fold-provider bugs
(below), now fixed; further interactive checks still recommended before merge (the
headless suite can't paint carets).

**Fold-provider follow-up (the inversion's second half — DONE):** Stage 2 inverted
`EditorModel`/`Cursor`, but the `FoldProvider` + fold-reveal caret were still
screen-era, which broke two interactions found in GUI testing:
- **`zo`/`za` placed the caret at the wrong row** — `toggleFold`'s `RevealedRange`
  is in SCREEN coords, but `placeCaretInRevealedFold` fed it into the now
  buffer-space `setCursorBufferPosition`. Fixed: translate the range screen→buffer
  first.
- **`5j` got trapped on the fold marker** — `FoldProvider.isFoldedAtRow` →
  `isLineHidden()` always returned `false` (a screen-era stub), so the vim
  fold-skip was inert and `j` stepped into hidden document rows. Fixed: new
  document-space `SyntaxController.documentFoldRangeAtRow`/`unfoldDocumentRow`
  (backed by `Document`/`ProjectionView.foldDocumentRowSpan`), wired through
  `FoldProvider.foldRangeAtRow` + `EditorModel.foldRowRangeAt`; the vim
  `getFold{Start,End}RowForRow` helpers now use it (replacing the unmodeled
  `displayLayer.foldsMarkerLayer`). Locked by a real-`SyntaxController` test.

**Known follow-ups (not blocking; niche, no-fold path unaffected):**
- `SyntaxController.foldRegions()` (→ `getFoldableRanges`, the `zj`/`zk`/`[z`/`]z`
  fold motions + `iz`/`az` text object) and `functionRangeAt`/`classRangeAt` (the
  `if`/`af`/`ic`/`ac` text objects) still return/consume SCREEN rows. Correct while
  no fold is active (identity); only wrong when one of those motions is used WITH a
  fold collapsed. Convert to document rows next.
- `dd` on a closed fold deletes only the header row, not the whole fold (vim deletes
  the fold). Reveal-on-edit only fires when the buffer range's screen projection
  touches the placeholder.
- `Selection`/`MarkerLayer`/`Marker` inherit the transform via the bridge but weren't
  separately audited; spot-check vim marks (`m`/`` ` ``) across a fold.

## Stage 3 — soft-wrap into screen coordinates (later, optional)

Model wrapped display rows in `screen` space so `screen` row ≠ `buffer` row under
wrap (today wrap is pixel-only). Large; only if a feature needs Point-level wrap
awareness.

## Parallel track — finish vim `as any` removal (independent of coordinates)

~50 vim casts remain that are **not** coordinate-related and can be done anytime,
by building the missing shim functionality (not by widening to `any`):

- **Operation hierarchy** (`operation-stack.ts`, `motion.ts`): narrow with the
  existing `isOperator()`/`isMotion()`/`isTextObject()` predicates; make
  `Base.getInstance` generic so `getInstance(...).getPairInfo()` keeps its type.
- **`Selection.insertText` options**: add `{autoIndent?, autoIndentNewline?}` and
  honor it via EditorModel's existing auto-indent primitives.
- **Long tail**: `getURI()` on EditorModel (wire a `Document` reference);
  `bufferRangeForScopeAtPosition` (needs a tree-sitter scope-extent query);
  `MANAGER_REGISTRY` heterogeneous-constructor typing; `editorElement`/
  `matchScopes` DOM-ism; `pair-finder.ts` options.
