# Virtual lines & inline virtual content

Survey of how to show content that **isn't in the buffer** — trailing text, full
virtual lines, inline widgets — on our GtkSourceView 5.20 editor. This is a
cross-cutting capability several features want; diff is just one. All APIs below
were probed and **exist in our node-gtk build**.

Two of the three tiers surveyed here are now built:

- **Tier 1 (§1) line-trailing annotations** → `VirtualText`
  (`src/ui/TextEditor/VirtualText.ts`), used by error-lens and end-of-line inlay
  hints.
- **Tier 2 (§2) gap-tag + overlay virtual line** → `BlockDecorations`
  (`src/ui/TextEditor/BlockDecorations.ts`), specced in
  [inline-widgets.md](inline-widgets.md). `add_overlay`/`move_overlay` take
  **buffer coordinates** (so the child scrolls with the text natively — no manual
  scroll-follow), `get_iter_location` returns the anchor's rect in buffer coords,
  and `Gtk.TextTag.pixels-below-lines`/`pixels-above-lines` reserve the gap.
  Consumers: the markdown image preview and the see-definition peek (which uses a
  sibling-overlay variant for focus — see inline-widgets.md).
- **Tier 3 (§3) child-anchor / read-only synthesized text** is still
  surveyed-only (used conceptually by the diff viewer's synthesized buffers).

> **Note — showing *less* than the model (single-line navigable code folding)
> uses a different mechanism: a view-side text *projection*. See
> [folding.md](folding.md).** GtkTextView can't join two real lines across an
> invisible newline, so the view buffer physically holds the collapsed one-liner
> (`import {[N]} from 'x'`) with the model as source of truth + view↔model
> translation. Complements the tiers here (those *add* content; the projection
> *removes* it).

## Features that want it

- **LSP inlay hints** — parameter names / inferred types, mid-line and end-of-line.
- **Error lens** — the diagnostic message shown after/below the offending line.
- **Git blame** — trailing author/date per line.
- **Code lens** — a line *above* a symbol (reference count, run/debug actions).
- **Inline AI completion / ghost text** — Copilot-style preview not in the buffer.
- **Inline diff** — deleted lines (unified) and alignment fillers (side-by-side)
  *while editing the live buffer* (the read-only viewer avoids this — see diff.md).
- **Folded-region placeholder** — "… 12 lines …" on the fold header.
- **Inline images / color swatches / markdown render / expandable panels.**

## The mechanisms (probed; all available)

There is **no single "virtual line" primitive** — but the building blocks cover
the needs in tiers.

### 1. `GtkSourceAnnotations` (5.18+) — line-anchored trailing text + icon

Per-LINE annotation: a `GtkSource.Annotation` carries `line` + `description`
(text) + `icon` + `style`, and the provider has `populateHoverAsync` for hover.
Model: `view.getAnnotations().addProvider(p)`; the provider exposes
`addAnnotation`/`removeAnnotation`/`removeAll`. Renders as **end-of-line**
trailing content.

- **Fits:** error lens, git blame, simple end-of-line inlay hints — with hover.
- **Limits:** line-anchored only (no column → no true *mid-line* inlay hints);
  end-of-line slot, not a full virtual line that pushes text down. (Built — see
  `VirtualText` below for the realized findings.)

### 2. Gap tag + overlay — the general virtual-LINE recipe

`Gtk.TextTag` exposes **`pixels-above-lines` / `pixels-below-lines` /
`pixels-inside-wrap`** — these reserve blank vertical *space* above/below a line
(no content). Fill that gap with either:

- **`view.addOverlay(child, bufX, bufY)` / `moveOverlay`** — a real widget at
  fixed *buffer* coordinates that scrolls with the text but takes no layout space
  (it sits in the reserved gap); or
- **`snapshot_layer`** custom drawing (the diagnostic squiggle does this via a
  DrawingArea overlay — `src/ui/TextEditor/UnderlineOverlay.ts`) — draw
  text/lines into the gap.

So: **tag reserves the vertical space (pushing real lines apart), overlay/snapshot
renders the virtual line into it.** This is the reusable "virtual line" engine.

- **Fits:** code lens (gap above), inline expanded diagnostics, multi-line ghost
  text, live inline-diff deleted blocks, inline images/previews.
- **Limits:** you own the geometry — compute the gap's pixel rect (`getIterLocation`
  + `bufferToWindowCoords`, which our `EditorModel` pixel-geometry already wraps)
  and reposition on scroll/edit; stacking several virtuals at one spot needs care;
  no automatic invalidation.

### 3. `GtkTextChildAnchor` — inline widget that takes space

`buffer.createChildAnchor`/`insertChildAnchor` + `view.addChildAtAnchor(child,
anchor)` embeds a **real GtkWidget** inline; it occupies layout space (a tall
widget on its own line ≈ a virtual line that genuinely pushes text down) and
**consumes one buffer char** (the anchor). `insertPaintable` is the image variant.

- **Fits:** inline widgets / expandable panels / images, and synthesized virtual
  blocks in **read-only** buffers.
- **Limits:** the anchor is a real char → it perturbs offsets, save, and search.
  **Not for the live editable buffer.** Best in read-only / synthesized buffers.

### 4. Synthesized read-only buffer — for pure viewers

For a *viewer* (diff), make the virtual content real text in a throwaway buffer
and style it. Sidesteps all of the above. Only works when not editing the live
file (see [diff.md](diff.md)).

## Outcome (built tiers)

Two pieces cover most needs, both reusing primitives already landed (the
pixel-geometry getters on `EditorModel`, the overlay pattern from the squiggle
layer):

1. **`GtkSourceAnnotations` for line-trailing text** — error lens, git blame,
   end-of-line inlay hints. Purpose-built, hover for free.
   - ✅ **Built** as `VirtualText` (`src/ui/TextEditor/VirtualText.ts`; POC
     `src/poc/annotations.ts`). Per-view (one of the things the A2 document-model
     unblocked — a shared buffer would render annotations in every view). Consumers:
     **error lens** (`src/lsp/diagnostics/DiagnosticsView.ts`) and **end-of-line
     inlay hints** (`src/ui/TextEditor/InlayHintController.ts`). Concrete API:
     `GtkSource.Annotation.new(description, icon, line, style)` + a concrete
     `GtkSource.AnnotationProvider` (no subclass) + `view.getAnnotations().addProvider()`.
   - **Findings:** (a) **render** only happens for a *populated* provider added to the
     view — mutating an already-registered provider (late `addAnnotation`) doesn't
     repaint, so `VirtualText` re-adds the provider each update. (b) **Color** comes
     from the *style scheme's* diff styles — `ERROR`→`diff:removed-line` fg,
     `WARNING`→`diff:changed-line`, `ACCENT`→`diff:added-line`, `NONE`→drawn-spaces
     color; our generated scheme defines them (`src/theme/createSourceScheme.ts`). (c)
     **Line-anchored, no column/alignment control** — and with **soft-wrap on the
     annotations right-align** to the wrap width rather than trailing immediately after
     the text (a GtkSourceView rendering behaviour, no API to change it). Mid-line /
     trail-immediately placement wants the §2 overlay recipe instead.
2. **Gap-tag + overlay virtual line** (§2).
   - ✅ **Built** as `BlockDecorations` (`src/ui/TextEditor/BlockDecorations.ts`;
     POC `src/poc/inline-overlay.ts`; specced in [inline-widgets.md](inline-widgets.md)).
     Given a buffer row and a widget, it reserves the band via a per-block
     `pixels-above/below` tag, drops a pooled "slot" `Gtk.Box` as an `add_overlay`
     child at the anchor's buffer-Y, and repositions via a tick callback on layout
     changes (`add_overlay` follows scroll for free but not fold-toggle/edit shifts).
     Consumers: markdown image preview (`plugins/markdown/imagePreview.ts`) and
     the see-definition peek (`src/ui/TextEditor/Peek.ts`, which uses a focusable
     sibling-overlay variant — `add_overlay` children leak IM input). This is the
     general capability behind code lens, ghost text, inline expanded diagnostics,
     and live inline-diff; mid-line inlay hints (a column annotations can't do) also
     fall here, via an overlay at the iter's pixel rect.
   - **Gotchas** (all handled in `BlockDecorations`): the view must be **mapped**
     before placing (pre-realize `get_iter_location` is 0; defer + retry);
     `gtk_text_view_remove` is a no-op in this node-gtk build, so removal hides and
     **pools** the slot rather than unparenting (unparenting corrupts the
     `GtkTextViewChild` overlay list → snapshot assertion); adding an overlay +
     changing the gap tag don't trigger `size_allocate`, so force `queueResize`.
3. **`GtkTextChildAnchor`** (§3) — *surveyed only*. Use only inside **read-only /
   synthesized** buffers (it dirties the live buffer); synthesized buffers stay the
   answer for the diff *viewer*.

## Net

No custom widget or fork is needed: line-trailing virtual text has a native API
(`GtkSourceAnnotations`, built as `VirtualText`), and general virtual lines are
built from `pixels-above/below` tags + buffer-coordinate overlays (`BlockDecorations`)
— both sit on top of GtkSourceView rather than replacing it, like the
search/decoration/buffer-only work.
