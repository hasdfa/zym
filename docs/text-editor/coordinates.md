# Editor coordinate spaces: document / buffer / screen

The canonical vocabulary for editor positions. Every `(row, column)` in the
text-editor stack lives in exactly one of three spaces; method names translate
between them with Atom's `XForY` convention (`screenPositionForBufferPosition`,
`bufferRowForScreenRow`, …). This page is the source of truth for the names —
code and the other text-editor docs are being migrated onto it (see
[Current state](#current-state-wip) and [VIM-PLAN.md](../../VIM-PLAN.md)).

## The three spaces

```
document  ──stitch (N→1)──▶  buffer  ──folds + soft-wrap──▶  screen
per-file source of truth     the editor's content           what's displayed
(Document model)             (multibuffer of excerpts)       (folded, wrapped)
```

- **document** — one source file's text, the headless `Document` model buffer
  and undo/LSP authority. Identified by a source key (path / blob id). The
  language server, file I/O, and go-to-definition speak *document* coordinates.
- **buffer** — the editor's logical content: N documents stitched into one
  stream (the multibuffer). A normal single-file editor is the degenerate case —
  one full-file excerpt, so `buffer` is identity to its one `document`. This is
  Atom's "buffer"; **vim / `Cursor` / `Selection` / `EditorModel` operate here.**
- **screen** — what is actually shown: `buffer` with code folds (tree-sitter)
  and soft-wrap applied. Atom's "screen". Scrolling, visible-row range, caret
  pixels, and display-line motion (`gj`/`gk`) speak *screen* coordinates.

## Transforms and where they live

- **document ↔ buffer** — the multibuffer stitch (segment map) in
  `CoordinatesMap`. Single file = identity, short-circuited.
- **buffer ↔ screen** — code folds (the `CoordinatesMap` fold transform,
  materialized into the view buffer) plus soft-wrap (GtkSourceView at render
  time; pixel geometry for `gj`/`gk`).

## Who speaks which space

| Layer | Space |
|---|---|
| LSP, file I/O, `Document`, go-to-def | document |
| vim, `Cursor`, `Selection`, `EditorModel`, marks, mutation | buffer |
| scroll / viewport, gutters, fold rendering, caret pixels | screen |

## Two deliberate inversions

Read these — both are intentional and will mislead if you assume otherwise.

1. **`buffer` is the stitched multibuffer, not a single file** — the opposite of
   Zed's convention (where `buffer` = one file, `multibuffer` = the stitch). We
   follow Atom because the vendored vim layer does; a single source file is one
   full-file **excerpt** of the buffer.
2. **`GtkSource.Buffer` is storage, not a coordinate level** — GTK is an
   implementation detail. The headless `GtkSource.Buffer` stores `document`; the
   materialized view `GtkSource.Buffer` stores `screen`. The `buffer` space
   itself is logical (computed by `CoordinatesMap`) with no dedicated
   `GtkBuffer`. Never infer a coordinate level from a GTK buffer field name.

## Current state (WIP)

The vocabulary above is the target; the code is mid-migration.

- **Stage 1 done — the projection layer speaks the canonical names.**
  `CoordinatesMap` (`documentToScreen` / `screenToDocument` /
  `bufferOffsetToScreen` / `screenOffsetToBuffer` / `bufferRowForDocument` / …,
  `Segment.documentKey`, `ScreenTarget`/`DocumentPosition`), the `ScreenProjection`
  contract — fold + document↔screen translation, implemented by `Screen` and held
  directly by `SyntaxController` / the cursor model (so the `Document` no longer routes
  fold calls by view buffer) — (`documentLineForScreenLine` / `screenLineForDocumentLine` /
  `documentPointFromScreen` / `screenPointFromDocument` / `fold` / …),
  and `SyntaxController`'s internal translators (`documentRow` / `screenRow` /
  `documentPos` / `screenIterForDocument` / …) are all on **document / buffer /
  screen**. This was a rename-only change (no behavior change).
- **Stage 2 done (folds) — `EditorModel` / `Cursor` speak `buffer`; `buffer ↔
  screen` is the real fold transform.** The **decision: vim motions operate on
  `buffer`** (unfolded, Atom-faithful) — the ported callers assume Atom's
  `*BufferPosition` = unfolded text, and this page already assigns vim to
  `buffer`. So `EditorModel`'s buffer-space API (cursor/selection positions, line
  text, counts, scan, EOF) reads the **unfolded source**, and its `screen` methods
  (`screenPositionForBufferPosition` / `bufferPositionForScreenPosition` /
  `screenRowForBufferRow` / `bufferRowForScreenRow` / `clipScreenPosition` /
  the `screen↔buffer` ranges, plus `Cursor.get/setScreenPosition`) delegate to the
  fold transform. Mechanics:
  - The materialized **view buffer IS `screen`** (a fold physically replaces text
    with a `[N]` placeholder). `EditorModel` translates at its GTK bridge —
    `iterAtPoint` (buffer→screen) / `pointAtIter` (screen→buffer) — and routes
    content reads to the headless document. `screenIterAtPoint` is the raw
    screen-in/screen-iter-out bridge for the genuine screen callers
    (`pixelPositionForScreenPosition`, `clipScreenPosition`, scroll-to-screen).
  - For a single-file editor `document == buffer`, so the `FoldAccess`
    translators (delegating to the view's `ScreenProjection`) ARE the `buffer` ones.
  - Gated to **single-document editors** (`EditorModel.foldProjection`): a
    multibuffer keeps `buffer == screen` (folding off) and buffer-only editors have
    no projection — both stay identity. With **no active fold the transform is
    identity**, so the whole no-fold path (and the full test suite) is byte-for-byte
    unchanged. Validated by `EditorModel.test.ts`'s fold-active tests.
- Soft-wrap is GTK-rendered; only `gj`/`gk` thread it (via pixels), not the
  Point-based screen coordinates. (Stage 3.)
- **Stage 3 target:** model soft-wrap in `screen` coordinates too, so a wrapped
  buffer row spans several screen rows in Point space (today wrap is pixel-only).

## Old → new name map

| Old (in code/docs) | New |
|---|---|
| `source`, `model` | `document` |
| `projection`, `proj` | `buffer` |
| `view` | `screen` |
