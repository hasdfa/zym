# Document registry (shared buffers, multiple views)

**Decision (chosen, deferred):** split a **Document** (the buffer + its document-
level state) from the **view** (`TextEditor`), keep a registry of open documents by
path, and allow **N views per document** with **independent per-view cursors**. This
is the "proper" model that lets a see-definition peek (and a split-view of the same
file) share the live buffer — so edits, the modified flag, and undo are shared,
while each view scrolls/navigates on its own. To be done as a dedicated refactor;
until then, the peek shows a **read-only snapshot slice** (see
[inline-widgets.md](inline-widgets.md)).

## Why it's needed (the crux)

Today every `TextEditor` creates and owns its own `GtkSource.Buffer`; "modified" is
just `buffer.getModified()`, and files are deduped one-editor-per-path
(`AppWindow.openFile`). To make a peek (or a second view) reflect edits + the
modified dot, the two views must share document state.

The native shortcut — two `GtkSource.View`s on **one** `GtkSource.Buffer` — shares
edits/modified/undo for free, **but also shares the cursor and selection**: quilx's
*primary* cursor IS the buffer's native insert mark (`EditorModel.getCursorBufferPosition`
→ `buffer.getInsert()`, `setCursorBufferPosition` → `buffer.placeCursor`). So
navigating/editing in one view would move the other's cursor. That's why a clean
multi-view model needs a real refactor rather than just sharing the buffer.

## Design sketch

- **`Document`** owns: the `GtkSource.Buffer`; the `SyntaxController` (one parse /
  highlight pass for the buffer, not one per view); the LSP document
  (`LspDocument`); file I/O (load/save); the modified flag + undo; the dirty/disk
  relationship. Keyed by absolute path in a registry (`Workspace`/a new
  `DocumentRegistry`). `openFile` resolves to a shared `Document`.
- **`TextEditor` becomes a view** onto a `Document`: the `GtkSource.View`, the vim
  layer, decorations, the minimap, gutters, completion/hover UI, and **its own
  cursor/selection**. Multiple views attach to one document.
- **Per-view cursor** — the key change: move the primary cursor off the buffer's
  native insert mark onto a per-view emulated mark (the `MarkerLayer` machinery that
  already backs extra cursors). `EditorModel`'s cursor read/write, caret rendering
  (already custom via `caretLayer`), and vim motions route through the per-view
  mark instead of `buffer.getInsert()`/`placeCursor`. GtkTextView still has one
  native insert mark; keep it parked/in sync for the focused view, or suppress its
  caret entirely (we already custom-draw the caret).

## What it unlocks

- **See-definition peek** sharing the open buffer: edits in the peek show in the
  open tab + flip the modified dot; external edits show live in the peek.
- **Split view of the same file** (two panes, same document, independent cursors).
- One highlight/LSP pass per document regardless of how many views show it.

## Phased plan

Sequenced so each phase lands independently and is testable; the high-risk cursor
change is isolated to one phase.

0. **Extract `Document` (pure refactor, 1:1).** Move buffer + `SyntaxController` +
   `LspDocument` + file I/O + modified/dirty out of `TextEditor` into a `Document`
   it holds 1:1; delegate. Each editor still makes its own. No behavior change —
   verify tests + app unchanged.
1. **`DocumentRegistry` + dedup + lifecycle.** path → `Document`;
   `AppWindow.openFile` gets-or-creates a shared `Document`, **ref-counted** (dispose
   on last view close, not while open elsewhere). Still one view per document.
2. **Per-view cursor (crux, high-risk).** Move the primary cursor off
   `buffer.getInsert()` onto a per-view emulated mark (reuse `MarkerLayer`); route
   `get/setCursorBufferPosition`, selection, and vim motions through it; suppress
   GtkTextView's native caret (already custom-drawn). Heavy vim regression testing.
   Still 1 view/document (no visible change), but cursors are now view-local.
3. **N views per document.** Multiple views attach to one `Document` (own
   cursor/vim/decorations each); one `SyntaxController` per document; modified/undo
   shared via the buffer; the tab modified-dot reflects the shared document.
4. **Consumers.** See-definition peek → a view on the definition's `Document` (live
   buffer; own cursor; snapshot fallback when not open). Split-view-of-same-file.

## Risk / sequencing

- The per-view-cursor change to `EditorModel` is the high-risk part (it's threaded
  through motions, selection, multi-cursor, vim). Land it behind the existing
  multi-cursor mark machinery; extensive vim regression testing.
- **Decorations are buffer-level**: `editor.decorations` applies `GtkTextTag`s to
  the buffer, so a view-local highlight (search current-match) would **leak across
  views** of one document. Phase 3 needs view-local highlighting via custom draw, or
  we accept shared highlights in v1. (Document-level decorations like diff are fine.)
- **Lifecycle**: ref-count the `Document`; don't tear it down (close its LSP doc,
  etc.) while any view remains. LSP/undo fit `Document` naturally (one
  `didOpen`/`didChange` per file; undo is buffer-level → shared, as expected).
- Until this lands, keep the peek as a read-only snapshot (no shared state) — it's
  correct, just not live.

Related: [[text-editor.md]] (widget decision: stay on GtkSourceView, emulate),
[inline-widgets.md](inline-widgets.md) (the peek consumer).
