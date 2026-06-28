# Per-row gutter cell background (diff filename-header band)

Draw an arbitrary per-row background rectangle in a
`GtkSourceGutterRenderer` — used to paint the empty band beside a diff
file's filename-header widget so there is no visual notch between the
gutter and the header.

## Goal

In the editable diff multibuffer (`DiffMultiBufferView`), each file's
filename header is a real widget shown in a reserved band **above** the
excerpt's first content row (a `BlockDecoration` — a `GtkTextTag` with
`pixels-above-lines = widgetHeight` applied to that row, which enlarges
the row's cell and leaves an empty band that the overlay widget fills in
the *text* area).

The **line-number gutter** region beside that filename widget (i.e. the
empty pixels-above band portion of the first content row's gutter cell)
is painted with the **same background color as the filename header**
(`theme.ui.surface.selected ?? theme.ui.surface.popover`), with **no
text** — so there is no visual notch between the gutter and the header
widget.

Generalized: this needs an **arbitrary per-row background rectangle
drawn in a `GtkSourceGutterRenderer`** (the band, or potentially full
cells).

## How it works

The band is drawn from the gutter renderer's `snapshot_line` override.
A `GutterRendererText` subclass overrides `snapshotLine(snapshot, lines,
line)` and:

- draws the band with `snapshot.appendColor(rgba, rect)`, where the
  rect's vertical extent comes from `lines.getLineYrange(line, CELL)`
  (the full cell height, which includes the `pixels-above-lines`
  reservation);
- chains up with `super.virtual_snapshotLine(...)` so the parent
  `GutterRendererText` still draws the line-number text on top.

The `super.virtual_<vfunc>()` chain-up is the load-bearing piece: it lets a
`GutterRendererText` subclass add a band **and** keep the parent's text
drawing. It was added to node-gtk (merged to node-gtk master, PR
romgrk/node-gtk#451). See the node-gtk super-vfunc-chain-up memory.

Per-row data is supplied by overriding `virtual_queryData(lines, line)`, which
is invoked once per visible row. It sets the line-number markup
(`[space][number][space]` per old/new column, background spans the
spaces) and per-row `yalign` (header rows bottom-align the number onto
the text; other rows top-align).

A broader perf finding from this work: **drawing the gutter from JS via
`snapshot` is a control feature, not a speed win** — it gives arbitrary
per-row drawing but does not make the gutter faster. See `text-editor.md`
→ "Gutter rendering".

## Still-governing constraints

- **Define gutter/renderer subclasses at module top level only.**
  Defining a `GObject` subclass **inside a function** segfaulted when it
  was registered (`g_type_set_qdata: assertion 'node != NULL' failed` →
  `cannot retrieve class for invalid type` → SIGSEGV). All existing
  renderers are module-level.
- **Instantiate vfunc-overriding subclasses only after the main loop is
  running.** `new` before then segfaults (see the node-gtk constraints
  memory).
- node-gtk wires a method into the vtable only when it is named
  `virtual_` + the camelCase vfunc name (`virtual_snapshotLine` overrides
  `snapshot_line`). A plain method is never an override; a `virtual_*`
  name matching no parent/interface vfunc throws when the subclass is
  registered (on its first construction).
- There is **no gutter-renderer background property** in GtkSource 5.x
  (`setBackgroundRgba` / `background-rgba` are absent / read as
  `undefined`); painting via `snapshot_line` is the supported path.
  Pango markup `background=` only fills the glyph run's logical rect (one
  text line tall), so it cannot fill the empty band.

## Remaining / planned

- The band drawing is proven on branch `feat/gutter-cell-background`
  (not yet merged).

## Files

- `src/ui/TextEditor/DiffLineNumberGutter.ts` —
  `CombinedDiffLineNumberRenderer` (per-row `queryData`: markup
  `[space][number][space]` + per-row `yalign`; `headerRows:
  Set<number>`), `CombinedDiffLineNumberGutter` (`setData`,
  `primeWidth`).
- `src/ui/TextEditor/BlockDecorations.ts` — reserves the band
  (`pixels-above-lines` tag) and places the header widget overlay; the
  band is empty in the gutter.
- `src/ui/multibuffer/DiffMultiBufferView.ts` — wires `headerRows(dmb)`
  into the gutter on build and on `reDiff`; `installOverlays`
  reconciles the header/gap bands.
- `docs/text-editor/inline-widgets.md` — BlockDecorations / overlay
  background.
