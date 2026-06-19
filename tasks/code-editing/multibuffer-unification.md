# Unifying the editor on the excerpt substrate (design — not yet built)

**Question this answers:** should *every* `TextEditor` be multibuffer-backed — a normal file
being the degenerate case of one full-file excerpt — so folds, diagnostics, decorations,
gutters, and search are written once against a single coordinate space?

**Verdict:** yes as the end-state (it matches the plan's framing — "a fold hides ranges of
one Document; a multibuffer concatenates slices of many"), but **after** Phase 1b + 2. It's
a maintenance win, not a performance one, and it depends on editable write-through being
proven first. This doc is the migration design; see [multibuffer.md](multibuffer.md) for the
phases that precede it.

## Where we are: two projection mechanisms

Both already materialize a view `GtkSource.Buffer` that is a *projection* of source text —
they just don't share a layer:

1. **Document A2 model** (`Document.ts`) — normal editor. `Document` owns the headless
   `model` buffer; `createView()` hands each view its own `GtkSource.Buffer`, kept in 1:1
   sync by edit-forwarding (`forward` view→model, `propagate` model→views). Folds physically
   collapse the view buffer (`foldViewRange` delete+insert a `[N]` placeholder) with
   view↔model mark translation (`toModelOffset`/`toViewOffset`, `viewPointFromModel`,
   `modelLineForViewLine`, …). So the view buffer = projection of **one** Document via folds.
   **Editable, native.**
2. **Excerpt model** (`ui/multibuffer/MultiBufferModel.ts`) — the multibuffer. A synthesized
   concatenation of N source slices + a `RowEntry[]` map (`sourceAt`/`viewRowForSource`/
   `segmentsInViewRange`). **Read-only** (Phase 1a).

The painter (`SyntaxController`) was *already* generalized in Phase 1a to paint through a
`SyntaxProjection` (it consumes either the single-source+fold path or the excerpt path) — so
the highlighting half of the unification is partly done.

## Target: one `ViewProjection` per view

A per-view object owning the relationship between the view buffer and its source Document(s).
It generalizes today's `Document` fold logic **and** `MultiBufferModel` into one layer:

- **Input** — an ordered list of `Segment { source: Document, sourceRange, editable, kind }`
  plus block rows (headers/gaps). A normal file = **one** segment spanning the whole
  Document, `editable`, no blocks.
- **Materialize** — build the view buffer text = concatenation of segment source texts (+
  blocks). For the one-full-file segment this is exactly the file text (identical bytes to
  today's `createView` seed).
- **Coordinate map** — view offset/row ↔ `(segment, sourceOffset/row)`. Today's
  `MultiBufferProjection.sourceAt` generalized; today's fold `toModelOffset`/`toViewOffset`
  become a **second transform composed on top** (a fold hides a sub-range of a segment's
  contribution). Like Zed's display-map transform stack (excerpts → folds → wraps).
- **Edit write-through** — a view edit at offset O → `(segment, sourceOffset)`; if the
  segment is `editable`+`real`, apply to `segment.source`'s model (which propagates back) and
  re-materialize affected rows. This **is** today's `Document.forward`, generalized; for one
  full-file segment it's identity → today's behavior exactly.
- **Reverse sync** — when a source Document changes (live edit elsewhere), re-materialize its
  segment rows. This is what a *live* multibuffer needs (Phase 2) and what the read-only
  snapshot currently punts.

The painter then uses `paintSlices` for **all** editors; the single-source path is deleted
(it's just a one-segment projection). The gutter's `modelLineFor`, diagnostics'
`viewLineForModelLine`/`viewPointFromModel`, inlay hints, and search all retarget to the
projection map (identity for one segment).

`Document` shrinks to a **source**: model buffer + `DocumentSyntax` parse + LSP + file I/O.
The per-view buffer, sync, and fold methods migrate out to `ViewProjection`.

## Hard problems (the real cost)

1. **Editing near boundaries.** One full-file segment with no folds = identity (safe). The
   risk is edits on block rows, across excerpt boundaries, or spanning a fold — must clamp or
   reject (already flagged in multibuffer.md "correctness notes").
2. **Undo/redo across sources.** Today undo runs on the one Document model. A multibuffer
   touching N sources needs a policy: per-source stacks, or a coordinated transaction
   spanning sources (multi-file refactor = one undo step). One segment = identity.
3. **Folds: physical vs transform.** Today folds physically rewrite the view buffer; the
   excerpt map re-keys analytically. Unifying means picking one: re-materialize without
   hidden rows (consistent, but rebuilds buffer regions on toggle) vs an invisible-tag
   transform (the approach the fold work moved away from). Merge `Document`'s fold marks with
   the excerpt re-keying.
4. **Per-source decorations.** Diagnostics/inlay-hints/git-gutter key off one Document's
   model today; in a multibuffer each excerpt's come from its own source and place through
   the unified map. Touches `DiagnosticsView`, `InlayHintController`, `GitGutter`.
5. **Per-source gutter.** Line numbers must show each file's real numbers; `GutterRenderer`
   → `modelLineFor` generalizes to "source line at view row".
6. **Zero-cost single-file path.** The one-segment, no-block, no-fold case MUST short-circuit
   the map (identity) so normal editing/painting has no per-edit/per-paint overhead vs today
   — the same "identity unless folds" discipline Phase 0 established.
7. **`Document` refactor.** Moving view/sync/fold out of `Document` is invasive; the normal
   editor's behavior is the regression invariant.

## Migration path (each step shippable, tests green)

- **A. Phase 1b + 2 first** (read-only diff multibuffer, then editable write-through). Proves
  excerpt write-through + reverse-sync + boundary clamping on a *bounded* surface before the
  normal editor depends on it. **Prerequisite for B–E.**
- **B. Extract `ViewProjection`** from `Document`: view↔model + folds + materialize move into
  a per-view projection the `TextEditor` owns; `Document` becomes a source. Behavior for the
  one-segment case must be byte-identical (heavy regression tests on the normal editor).
- **C. Collapse the painter's dual path** — everything through `paintSlices`; the
  single-source+fold path becomes a one-segment projection. (Phase 0 already staged this.)
- **D. Normal editor = one-excerpt projection** — `TextEditor` always builds a projection
  (default: one full-file editable excerpt); the multibuffer is the same with N excerpts.
  Delete the buffer-mode/`syntaxProjection` branching.
- **E. Generalize gutter / diagnostics / undo** to the projection coordinate space.

## Why after, not now

- Phase 2 write-through is the unproven, novel risk; B–D build on it.
- The diff multibuffer is a contained place to prove edit-routing before betting the normal
  editor on it.
- **No performance upside** (both substrates already share `DocumentSyntax`; unifying adds an
  identity-map indirection at best). The payoff is a single coordinate space to maintain —
  realized only once write-through exists regardless.

Net: keep the two mechanisms through Phase 1b/2; treat B–E as a deliberate "unify the display
model" phase once write-through is proven.
