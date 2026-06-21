# Per-row gutter cell background (diff filename-header band)

**Status (2026-06-20): UNBLOCKED — node-gtk part solved; band drawing proven on branch
`feat/gutter-cell-background` (not merged).** The "blocked on node-gtk" diagnosis below was stale:
the `snapshot_line` override DOES fire (the old "never fires" was a module-level-init segfault), and
an arbitrary per-row background is drawable via `snapshot.appendColor` + `lines.getLineYrange(line,
CELL)`. We also added a `super.<vfunc>()` chain-up to node-gtk (merged to its master, PR
romgrk/node-gtk#451) so a `GutterRendererText` subclass can add a band AND keep the parent's text
drawing. A working band + the broader snapshot-gutter perf finding (drawing from JS is a control
feature, not a speed win) are written up in `text-editor.md` → "Gutter rendering". The original
analysis below is kept for history. (Filed from `feat/multibuffer-phase0`.)

## Goal

In the editable diff multibuffer (`DiffMultiBufferView`), each file's filename header is a real
widget shown in a reserved band **above** the excerpt's first content row (a `BlockDecoration` —
a `GtkTextTag` with `pixels-above-lines = widgetHeight` applied to that row, which enlarges the
row's cell and leaves an empty band that the overlay widget fills in the *text* area).

We want the **line-number gutter** region beside that filename widget (i.e. the empty
pixels-above band portion of the first content row's gutter cell) to be painted with the **same
background color as the filename header** (`theme.ui.surface.selected ?? theme.ui.surface.popover`),
with **no text** — so there's no visual notch between the gutter and the header widget.

Generalized: we need to **draw an arbitrary per-row background rectangle in a
`GtkSourceGutterRenderer`** (the band, or potentially full cells).

This is the only unshipped part of the gutter polish. Already shipped (works):
- Line-number format `[space][number][space]` per old/new column, background spans the spaces,
  no separator/`xpad` elsewhere (`DiffLineNumberGutter.ts` `cellMarkup`, `setXpad(0)`).
- Per-row `yalign` (header rows bottom-align the number onto the text; others top-align) — set
  inside `queryData`, see below.

## Why it's blocked

The gutter renderer can set per-line **text/markup** but we found no way to paint a **background**:

1. **No background API.** On `GtkSource.GutterRendererText` (node-gtk):
   present: `setAlignmentMode`, `setXpad`, `setYpad`, `getSize`, `setMarkup`, `setText`.
   absent: `setBackgroundRgba` / `getBackgroundRgba` / `setAlignment` / `setSize`.
   The `background-rgba` GObject property reads as `undefined` and has no JS setter (GtkSource 5.x
   appears to have dropped the old gutter-renderer background property). **Not yet tried:**
   `renderer.set_property('background-rgba', new Gdk.RGBA(...))` directly.

2. **`snapshot` / `snapshotLine` vfunc overrides are never invoked.** Subclassing
   `GtkSource.GutterRendererText` at module level and overriding `snapshot(snapshot, ...)` or
   `snapshotLine(snapshot, lines, line)` registers without error but the override is **never
   called** (instrumented counter stayed 0 across many painted frames). So custom drawing via the
   snapshot vfunc is not reachable through node-gtk's current binding for this class.

3. **`query_data` IS invoked per line.** Overriding `queryData(lines, line)` works per-row — proven
   because toggling `(this as any).yalign` inside `queryData` correctly bottom-aligns only header
   rows. So the per-line hook exists; only the *drawing* hook is missing.

4. **Pango markup background can't reach the band.** `setMarkup`'s `background=`/`background_alpha`
   only fills the glyph run's logical rect (one text line tall). The band is empty vertical space
   (the `pixels-above-lines` reservation), so no markup fills it.

5. **Gotcha (separate):** defining a `GObject` subclass **inside a function** and calling
   `registerClass` there **segfaults** (`g_type_set_qdata: assertion 'node != NULL' failed` →
   `cannot retrieve class for invalid type` → SIGSEGV). Define gutter/renderer subclasses at
   **module top level** only (all existing renderers already do).

## Probe snippets used (reproduce findings)

Run as a `*.test.ts` under the repo (needs `Gtk.init()`), drive frames with
`GLib.MainContext.default().iteration(true)` in a bounded loop after `win.present()`:

```ts
// (1) which methods exist — class MUST be module-level
class ProbeRenderer extends GtkSource.GutterRendererText {
  queryData(_l: any, line: number) { this.setMarkup(`${line}`, -1); }
}
registerClass(ProbeRenderer);
// ... new ProbeRenderer(); typeof r.setBackgroundRgba === 'undefined', etc.

// (2) snapshot vfunc never fires (calls stays 0)
class SnapRenderer extends GtkSource.GutterRendererText {
  queryData(_l: any, line: number) { this.setMarkup(`${line}`, -1); }
  snapshot(snapshot: any, ...rest: any[]) { calls++; /* parent.snapshot?.call(...) */ }
  // snapshotLine(snapshot, lines, line) { calls++; }  // also never fires
}
registerClass(SnapRenderer);
// insert into view.getGutter(Gtk.TextWindowType.LEFT), pump frames → calls === 0
```

## Things to try next (node-gtk debugging)

1. **Direct GObject property:** `renderer.set_property('background-rgba', rgba)` and/or check the
   introspected property list for the renderer's GType. Confirm the installed GtkSource version
   (`pkg-config --modversion gtksourceview-5`) and whether it still exposes a gutter background.
2. **node-gtk vfunc registration:** node-gtk maps a JS method to a vfunc by `lodash.snakeCase`
   (`snapshotLine` → `snapshot_line`) and **only registers the override if the parent class
   actually defines that vfunc**. So the likely reason our override never fires is that
   `GtkSourceGutterRendererText` doesn't expose `snapshot`/`snapshot_line` as an overridable vfunc
   in the typelib node-gtk sees. Verify against the gtksourceview-5 GIR (is `snapshot` a class
   vfunc or a sealed method?) and the node-gtk version. (`query_data` works because the parent
   defines it.) Also: **instantiate vfunc-overriding subclasses only after the main loop is
   running** — `new` before then segfaults (see the node-gtk constraints memory).
3. **Subclass the base `GtkSource.GutterRenderer`** (not `...Text`) and implement `snapshot` +
   `measure` fully (draw the bg rect + draw the number text ourselves via Pango/Cairo or a child
   layout). Base-class vfuncs may be wired where the Text subclass's are not.
4. **Fallbacks if drawing stays unavailable** (these are the options presented to the user; they
   chose to debug node-gtk first):
   - **Color the whole line-number gutter** with the surface color via CSS on the gutter widget
     (simple; band matches, but every line number sits on that shade).
   - **Extend the header widget over the gutter:** make the filename band a *sibling overlay*
     spanning the whole `SourceView` (gutter + text) instead of a text-area `add_overlay` child —
     see the sibling-overlay note in `docs/text-editor/inline-widgets.md`. Bigger change to the
     shared `BlockDecorations` (also affects project-search headers).

## Files

- `src/ui/TextEditor/DiffLineNumberGutter.ts` — `CombinedDiffLineNumberRenderer` (per-row
  `queryData`: markup `[space][number][space]` + per-row `yalign`; `headerRows: Set<number>`),
  `CombinedDiffLineNumberGutter` (`setData`, `primeWidth`).
- `src/ui/TextEditor/BlockDecorations.ts` — reserves the band (`pixels-above-lines` tag) and places
  the header widget overlay; the band is empty in the gutter.
- `src/ui/multibuffer/DiffMultiBufferView.ts` — wires `headerRows(dmb)` into the gutter on build
  and on `reDiff`; `installOverlays` reconciles the header/gap bands.
- `docs/text-editor/inline-widgets.md` — BlockDecorations / overlay background.
