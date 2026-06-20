# Inline widgets (block decorations & peek)

Two built primitives for showing **real content between buffer lines** that is
**not in the buffer** — a label, an image, or a full nested widget (e.g. a
see-definition peek that inlines another `TextEditor` below a line). They are the
"proper" virtual-line mechanism the [virtual-lines](virtual-lines.md)
investigation recommended.

- **`BlockDecorations`** (`editor.inlineBlocks`) — a non-interactive / click-only
  widget in a reserved gap below/above a line, parented to the **text window** so
  it scrolls natively. **Zero buffer footprint.** Built; only consumer today is the
  markdown image preview.
- **`Peek`** (`editor.showPeek`) — a **focusable** card (a nested `TextEditor`) in a
  reserved gap, parented to the editor's **sibling** `Gtk.Overlay` so it can take
  keyboard input. Built; drives see-definition.

> Note: these primitives *add* content (a widget/line not in the buffer). To show
> *less* than the model on one real navigable line — single-line code folding,
> including the diff viewer's `⋯ N unchanged lines` placeholder — use the view-side
> text **projection** in [folding.md](folding.md) instead. (The diff fold went the
> projection route, *not* a block, despite the earlier plan below.)

## POC findings (`src/poc/inline-overlay.ts`, run on a real display)

Confirmed by running the POC interactively:

- ✅ **`view.addOverlay(child, x, y)` reserves + renders.** With a
  `pixels-below-lines` gap tag on the anchor line, the overlay child sits in the
  band below that line.
- ✅ **Scrolls natively.** The overlay tracks its anchor as the text scrolls — no
  manual scroll-follow (buffer-coordinate child in the text window).
- ✅ **Pointer input works.** A `Gtk.Button` in the overlay receives clicks — so
  a clickable block (label/button) is fully supported.
- ✅ **Clean add/remove** once the view is realized. Two gotchas: build the
  overlay only *after* the view is **mapped** (pre-realize `get_iter_location`
  returns ~0 → the child lands at the top and can't be parented/removed), and
  **never remove the overlay child from the view**. In this node-gtk/GTK 4.22
  build `gtk_text_view_remove` is a **no-op** — it warns `"<widget> is not a child
  of GtkTextView"` and leaves the child parented to the private `GtkTextViewChild`
  (the overlay's real parent). Forcing `unparent()` then detaches the widget while
  the `GtkTextViewChild`'s internal overlay list still references it → a
  `gtk_widget_snapshot_child: assertion '_gtk_widget_get_parent (child) == widget'
  failed` CRITICAL on the next paint. **Fix (`BlockDecorations`):** the overlay
  child is a controller-owned **slot `Gtk.Box`** wrapping the consumer's widget;
  removal detaches the consumer widget (`Gtk.Box.remove`, which works) and **hides +
  pools the slot** for the view's lifetime, and `add()` reuses a pooled slot. Repro +
  regression check: `src/poc/overlay-churn.ts` (must print nothing on stderr).
- ❌ **A focusable nested GtkSourceView leaks text input.** Key *events*
  (backspace/enter/arrows) reach the focused nested view, but **letter input
  (IM-commit) goes to the OUTER view** — because the overlay child is a
  *descendant* of the outer GtkTextView, so the outer view sees focus as still
  "within" itself and keeps its IM context active. Claiming the press (so the
  outer view doesn't steal focus on click) was necessary but not sufficient.

**Conclusion — two placement strategies:**

1. **Non-interactive / click-only content → `add_overlay`** (text-window child).
   Image previews, ghost text, code-lens buttons. Fully de-risked → `BlockDecorations`.
2. **Focusable / text-input content (see-definition peek) → gap-tag + a *sibling*
   overlay**, i.e. the widget goes in the editor's `Gtk.Overlay`/`Gtk.Fixed`
   layer (the existing hover/squiggle pattern — *not* a child of the text view),
   positioned at the gap via buffer→window coords with manual scroll-follow. A
   sibling (not descendant) means focus genuinely leaves the outer view → its IM
   context releases → no input leak. Costs the manual scroll-follow the
   text-window overlay gave for free, but it's the proven pattern in this codebase.

## The mechanism (APIs confirmed in our build)

Probed in `Gtk-4.0.gir` — all present in this node-gtk/GTK4 build:

- **`gtk_text_view_add_overlay(child, xpos, ypos)`** / **`move_overlay`** /
  **`remove`** — place a real widget at a **fixed buffer coordinate** in the text
  window. Because it lives in the text window, **it scrolls with the text for
  free** — we do *not* reposition on scroll (unlike the diagnostic squiggle, a
  `Gtk.Fixed` overlay we scroll-follow manually).
- **`Gtk.TextTag.pixels-below-lines` / `pixels-above-lines` / `pixels-inside-wrap`**
  — reserve a blank vertical *band* below/above a line (pushes real lines apart).
- **`gtk_text_view_get_iter_location(iter)`** → the line's rect **in buffer
  coordinates** (so positioning the overlay needs no window conversion);
  `get_line_yrange`, `get_visible_rect`, `buffer_to_window_coords` available if
  window coords are ever needed.

Recipe: **the tag reserves the gap, the overlay child fills it at buffer coords,
scrolling is automatic.** The only moving part is keeping the gap height equal to
the child's height and repositioning when the buffer changes *above* the anchor.

## Why not the alternatives

- **`GtkTextChildAnchor`** — embeds a real widget but **consumes one buffer char**
  → perturbs offsets / search / save on the live buffer. Keep only as a fallback if
  overlay geometry proves troublesome.
- **`GtkSourceAnnotations`** — end-of-line trailing text only; no own row, no
  click-to-expand. Right for error-lens / blame, wrong for a block.
- **Synthesized real line** (a `FoldRow`-style placeholder that is buffer text) —
  selectable/editable and perturbs row mapping; the block avoids it. (For *folds*
  specifically, the view-side projection in [folding.md](folding.md) is used instead.)

## The primitive: `BlockDecorations`

Lives beside `TextDecorations` (one per editor, `editor.inlineBlocks`).

```ts
const handle = editor.inlineBlocks.add({
  line,                 // anchor row (buffer)
  widget,               // any Gtk.Widget
  placement: 'below',   // gap below the anchor line ('above' = pixels-above)
});
handle.invalidate();    // re-measure the widget height + reposition (after its size changes)
handle.remove();        // drop the band + overlay + anchor mark
```

(Options are exactly `{ line, widget, placement? }` — no width option; see
`BlockDecorations.ts`.)

Each handle owns three things:

1. **A `GtkTextMark` at the anchor line** (left gravity), *not* a raw line number
   — lines shift as a live buffer is edited; the mark tracks them. Position =
   `get_iter_location(mark).y + .height` (bottom of the anchor line), `x = 0` (text
   origin). Static in the read-only diff; the same code serves the live editor.
2. **A dedicated gap tag** (`pixelsBelowLines = childHeight`) applied only to the
   anchor line. One tag per block (heights differ); the tag table growing by a
   handful is fine.
3. **The overlay child**, placed via `add_overlay(widget, x, bottomY)`.

### The hard part — dynamic height

Fixed-height blocks (a one-line label) are trivial; a variable-height child is the work:

- Measure the child (`child.measure(VERTICAL, width)`), set `tag.pixelsBelowLines = H`,
  then `move_overlay` to the anchor bottom. `handle.invalidate()` re-runs this.
- **Guard the loop**: setting the tag relayouts, which can re-emit size signals — act
  only when H differs from the last applied value.
- **Reposition triggers**: layout shifts that move anchors (edits above, fold toggles)
  via `repositionAll()` — **not** scroll (the text-window overlay scrolls for free).
  In the read-only diff the buffer is static, so this reduces to "place once."

### Focus / input (resolved)

A `BlockDecorations` child is a *descendant* of the text view, so a focusable nested
editor would leak IM input to the outer view — hence `BlockDecorations` is click-only.
Focusable content uses the sibling-overlay `Peek` instead (focus genuinely leaves the
outer view → its IM releases). See the POC findings above.

## Consumers (built)

1. **Markdown image preview** (`BlockDecorations`) — `plugins/markdown/imagePreview.ts`.
   The only `BlockDecorations` consumer. See *Future consumers* for the details.
2. **See-definition / peek** (`Peek`) — a full-width nested read-only `TextEditor`
   below the symbol's line, height-capped with internal scroll, Escape to close.
   Sources the definition from the existing LSP go-to plumbing; uses a live shared
   `Document` when the file is already open, else a disk snapshot. See plan steps 4–6.

> The fold placeholder is **not** a consumer: the diff viewer collapses unchanged
> runs to a `⋯ N unchanged lines` placeholder via the view-side fold projection
> (`SyntaxController.foldViewRange`, see [folding.md](folding.md) / [diff.md](diff.md)),
> not via a block. The plan step 3 below describing a block conversion is superseded.

## Plan / sequencing

1. [x] **Geometry POC** — `src/poc/inline-overlay.ts` (`pnpm poc:inline`). Ran on a
   real display; results in *POC findings* above. Net: `add_overlay` is confirmed
   for non-interactive/click content (placement, native scroll, clicks, clean
   add/remove); a focusable nested editor leaks text input (descendant-of-textview
   IM problem) → interactive content needs the sibling-overlay strategy. (Headless
   here only confirms API bindings; rendering needs the real display. node-gtk #442:
   defer the top-level `app.run` by one macrotask or the app exits 0 immediately.)
2. [x] **`BlockDecorations` — `add_overlay` (non-interactive) path.**
   `src/ui/TextEditor/BlockDecorations.ts`: mark anchor + per-handle gap tag +
   text-window overlay; measures the child and sets the gap to match; defers
   placement to `map` and **retries until line geometry is valid** (map fires before
   the first layout pass → `get_iter_location` is 0); on remove, detach the consumer
   widget and hide+pool the slot (never `unparent` the slot — see POC findings);
   `repositionAll()` for layout shifts. API `add({line, widget, placement})` /
   `handle.remove()` / `handle.invalidate()`. Verified on a real display via
   `pnpm poc:inline` (placement, toggle, click, scroll-follow). Exposed as
   `editor.inlineBlocks`.
3. [~] **~~Convert the fold placeholder to an inline block~~ — SUPERSEDED.** The diff
   fold instead uses the view-side **projection** primitive: `foldUnchanged`
   (`src/util/DiffModel.ts`) returns fold regions over real buffer rows (no `FoldRow`),
   and `SyntaxController.foldViewRange` physically replaces each collapsed run with the
   `⋯ N unchanged lines` placeholder text in the view buffer (see [folding.md](folding.md)).
   The placeholder is non-editable projected text, not a block. This kept the diff and
   single-line folding on one mechanism. The node-gtk timing gotchas below were learned
   while building `BlockDecorations` and still apply to its consumers.

   **node-gtk timing gotchas (hard-won — all in `BlockDecorations`):**
   - **Place only after geometry is valid.** `get_iter_location` returns 0 before
     the view's first layout (and `map` fires before it), so placement retries on a
     16ms timer until the anchor's line rect is non-zero.
   - **Never place synchronously inside a layout-invalidating action.** A block
     added during a fold collapse runs right after `applyTag(invisible)` invalidated
     the layout; `addOverlay` then leaves the overlay child unallocated until an
     external relayout (a window resize would reveal it). Route *all* placement
     through the deferred flush so the invalidation settles first.
   - **Force the relayout.** `DiffFold` and the controller call `queueResize()` after
     a fold change — the cooperative loop won't otherwise re-allocate.
   - **Reposition via a frame-clock tick callback** (a few frames after a change),
     not idle/timeout (which fire mid-transition and read bogus coordinates); guard
     against moving to a zero-height (invalid) rect.
4. [x] **Sibling-overlay variant** — `Peek` (`src/ui/TextEditor/Peek.ts`):
   the peek card is a direct child of the editor's `Gtk.Overlay` (a SIBLING of the
   text view, so focusing it releases the outer view's IM → no input leak),
   positioned at the gap via the overlay's **`get-child-position`** (exact +
   unclamped, and only the card's rect is allocated → clicks/scroll outside it reach
   the file). Scroll-follow re-runs the overlay allocation on the vadjustment change.
   POC `src/poc/sibling-peek.ts` (`pnpm poc:peek`) proved focus/IM + input pass-through
   + scroll-follow on a real display. **Depends on node-gtk #444 / PR #445**
   (caller-allocated out-struct signal params — `get-child-position`'s `GdkRectangle*`).
   Wired into `TextEditor` as `showPeek`/`closePeek`/`peekOpen`.
5. [x] **See-definition** — `lsp:peek-definition` command (`space l p`, toggles) in
   `AppWindow.peekDefinition` fetches the LSP definition (`quilx.lsp.goto`) and shows it
   via `editor.showPeek`. Two paths: if the definition's file is already open, peek a
   live read-only `TextEditor` onto its shared `Document` (`revealPeekRow` +
   `wrapPeekBody`); otherwise a read-only snapshot slice read from disk
   (`buildDefinitionPeek` — highlighted slice + header with file:line + ✕, Escape closes).
   Construction smoke test: `node scripts/peek-demo.ts`.
6. [x] **Live buffer** — done via the **document registry** (shared `Document`, N views,
   per-view cursors — `src/ui/TextEditor/Document.ts`, `DocumentRegistry.ts`, see
   [document-registry.md](document-registry.md)). When the peeked file is open, edits in
   the peek and the tab reflect in each other; the disk snapshot is the closed-file
   fallback.

## Risks / open questions (mostly resolved)

- Geometry on a realized view, and the focus/IM leak, were the original unknowns —
  both settled by the POCs (gap-tag overlay confirmed; focus leak solved by the
  sibling-overlay `Peek`). Construction-only tests still can't verify rendering, so
  visual changes need an interactive run.
- Height-loop stability with a live-resizing nested editor (guarded re-measure).
- Repositioning cost when many blocks exist + frequent edits above them (debounce;
  only blocks below an edit need a move). Not a concern for the static diff.

## Net

No fork or custom widget: a small `BlockDecorations` (per-line gap tag +
buffer-coordinate overlay child) plus the sibling-overlay `Peek`, both on top of
GtkSourceView, cover non-interactive blocks and focusable peeks with a zero
buffer-footprint, natively-scrolling overlay. Both are built; the rest below are
candidate consumers.

## Future consumers (ideas — NOT built unless marked ✅)

Candidate features on top of the two primitives. Each notes the primitive and the
existing infra it would reuse. Only the markdown image preview is built.

**Block (`BlockDecorations` — non-interactive / click):**

- ✅ **Markdown image preview** (built — `plugins/markdown/imagePreview.ts`):
  `![alt](src)` local images (relative / absolute / `file://`) render as a
  `Gtk.Picture` block below their line. Reconciled on a debounced rescan (blocks
  keep identity across edits and track their anchor mark, so typing doesn't reload);
  textures downscaled + cached per path/mtime; toggle `markdown.imagePreview`. Remote
  (`http(s)`/`data:`) deferred (async network).
- **Error lens** — the diagnostic message inline below the offending line. Reuses
  diagnostics (`DiagnosticsView`, squiggles).
- **Code lens** — `N references` / `run | debug` above a symbol (`placement: 'above'`).
  LSP `textDocument/codeLens`; reuses go-to / references.
- **Inline AI ghost text** — multi-line completion preview below the cursor. Reuses agents.
- **Math / other previews** — `$$…$$` etc. (Color literals already exist as the
  separate `color-preview` plugin — a decoration *tint*, not a block.)
- **Test / coverage results** by a test. *Needs a test-runner.*

**Peek (`Peek` — focusable, sibling overlay):**

- **Peek references / implementations / type-definition** — results list + preview
  inline. Reuses `find-references`. *Most natural next.*
- **Inline AI edit (Cmd-K style)** — a focusable prompt under the line → apply as a
  diff. Reuses agents.
- **Peek commit / blame diff** — inline a `DiffViewer` below a line. Reuses diff + git.
- **Inline rename** — a tiny inline editor for `lsp:rename` with live preview.
- **Inline merge-conflict resolution** — both sides inline with accept buttons. *Niche.*

**Separate mechanism — EOL trailing text (`GtkSourceAnnotations`, not built):**
end-of-line only; fits **inlay hints**, **git blame** (trailing author/date), and a
trailing **error-lens** variant. Survey in [virtual-lines.md](virtual-lines.md); needs
its own POC (confirm node-gtk provider vfunc binding).

**Suggested priority** (value ÷ effort): error lens → peek references → code lens;
most *distinctive*: inline AI edit + peek commit diff.
