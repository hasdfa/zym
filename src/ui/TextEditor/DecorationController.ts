/*
 * DecorationController — the editor's generic inline decoration surface: styled
 * spans painted over buffer ranges with GtkTextTags, grouped into named,
 * clearable *layers*.
 *
 * This is the shared rendering path for features that highlight ranges of
 * existing text (as opposed to the syntax highlighter): the search interface
 * (match highlights) and inline diff (line backgrounds) are the intended
 * consumers. Each producer owns a layer and, on every update, re-syncs it
 * (`clear()` then `decorate(...)` the current set) — search/diff recompute their
 * full set anyway, so no per-edit marker bookkeeping is needed; the underlying
 * tags move with edits between updates because GtkTextTags track the text they
 * cover.
 *
 * Tags are created lazily per (layer, style) so layers clear independently, and
 * raised to the top of the tag-table priority so a decoration sits above the
 * syntax colors.
 *
 * Two things deliberately live elsewhere: DIAGNOSTICS render their inline
 * squiggles as custom-drawn Cairo waves (`UnderlineOverlay`) plus gutter
 * source-marks (`lsp/diagnostics/DiagnosticsView`), not tags; and GUTTER icons /
 * inline VIRTUAL TEXT (inlay hints, inline-diff ghosts) want GtkSource
 * source-marks and `GtkSourceAnnotations` (5.18+; we're on 5.20), which land with
 * their consumers. This surface is text-tag background spans only.
 */
import { Gdk, Gtk, type SourceBuffer } from '../../gi.ts';
import { Range, type RangeLike } from '../../text/Range.ts';
import { theme } from '../../theme/theme.ts';
import type { EditorModel } from './EditorModel.ts';

/** The built-in decoration styles. Producers re-sync layers using these keys. */
export type DecorationStyle =
  | 'highlight' // search: every match
  | 'highlight-strong' // search: the current match
  | 'added' // diff: an inserted line (full-line background)
  | 'removed' // diff: a deleted line (full-line background)
  | 'filler' // diff (side-by-side): a blank alignment pad on the other side
  | 'word-add' // diff: the changed chars within an added line
  | 'word-del' // diff: the changed chars within a removed line
  | 'fold' // diff: a collapsed-unchanged-lines placeholder row
  | 'flash'; // vim: a brief flash over an operated/yanked range

// Style → background color (hex, alpha-capable via #rrggbbaa). Backgrounds rather
// than foregrounds so they compose with syntax colors. All tints come from the
// theme palette (kept dim so text stays readable).
const STYLE_BACKGROUND: Record<DecorationStyle, string> = {
  highlight: theme.ui.searchMatch,
  'highlight-strong': theme.ui.searchMatchCurrent,
  added: theme.ui.diffAddedBg,
  removed: theme.ui.diffRemovedBg,
  filler: theme.ui.diffFillerBg, // dimmed neutral pad for an aligned-but-empty row
  'word-add': theme.ui.diffAddedWordBg, // stronger, over the added line's background
  'word-del': theme.ui.diffRemovedWordBg, // stronger, over the removed line's background
  fold: theme.ui.diffFoldBg, // faint neutral band for a collapsed-context placeholder
  flash: theme.ui.flash,
};

// Diff line styles paint the *whole line* (paragraph background, full width);
// the rest are character-span backgrounds (word-level diff, search, flash).
const LINE_STYLES = new Set<DecorationStyle>(['added', 'removed', 'filler', 'fold']);

/** Parse a `#rgb(a)`/`#rrggbb(aa)` string into a Gdk.RGBA. */
function parseColor(hex: string): InstanceType<typeof Gdk.RGBA> {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}

export class DecorationController {
  private readonly editor: EditorModel;
  private readonly buffer: SourceBuffer;
  private readonly layers = new Map<string, DecorationLayer>();

  constructor(editor: EditorModel) {
    this.editor = editor;
    this.buffer = editor.buffer;
  }

  /** Get (or create) the decoration layer `name`. One layer per producer. */
  layer(name: string): DecorationLayer {
    let layer = this.layers.get(name);
    if (!layer) {
      layer = new DecorationLayer(this.editor, this.buffer, name);
      this.layers.set(name, layer);
    }
    return layer;
  }
}

/** A named set of decorations a single producer owns and re-syncs as a unit. */
export class DecorationLayer {
  private readonly editor: EditorModel;
  private readonly buffer: SourceBuffer;
  private readonly name: string;
  // Tags created lazily, keyed by a string (the built-in style, or a tint's
  // colors), so a repeated style/color reuses its tag and the whole layer clears
  // in one pass.
  private readonly tags = new Map<string, InstanceType<typeof Gtk.TextTag>>();

  constructor(editor: EditorModel, buffer: SourceBuffer, name: string) {
    this.editor = editor;
    this.buffer = buffer;
    this.name = name;
  }

  /** Paint a built-in `style` over `range`. Empty ranges decorate nothing. */
  decorate(range: RangeLike, style: DecorationStyle): void {
    this.apply(range, this.tagForStyle(style));
  }

  /** Paint an arbitrary background (+ optional foreground) over a char range — for
   *  producers whose colors aren't a fixed `DecorationStyle` (e.g. the color-preview
   *  plugin tinting a literal with the color it represents). Colors are any string
   *  `Gdk.RGBA.parse` accepts (`#rrggbb(aa)`, `rgb()/rgba()`, …). */
  tint(range: RangeLike, colors: { background: string; foreground?: string }): void {
    this.apply(range, this.tagForColors(colors));
  }

  /** Remove every decoration this layer has applied (the re-sync reset). */
  clear(): void {
    const [start, end] = this.buffer.getBounds();
    for (const tag of this.tags.values()) this.buffer.removeTag(tag, start, end);
  }

  private apply(range: RangeLike, tag: InstanceType<typeof Gtk.TextTag>): void {
    const r = Range.fromObject(range);
    this.buffer.applyTag(tag, this.editor.iterAtPoint(r.start), this.editor.iterAtPoint(r.end));
  }

  private tagForStyle(style: DecorationStyle): InstanceType<typeof Gtk.TextTag> {
    // Map key namespaced so it can't collide with a tint; tag *name* unchanged
    // (`deco:<layer>:<style>`) — consumers/tests look these up by name.
    return this.tagFor(`style:${style}`, `deco:${this.name}:${style}`, (tag) => {
      // Line styles use paragraph-background (full-width); spans use char background.
      if (LINE_STYLES.has(style)) (tag as any).paragraphBackgroundRgba = parseColor(STYLE_BACKGROUND[style]);
      else (tag as any).backgroundRgba = parseColor(STYLE_BACKGROUND[style]);
    });
  }

  private tagForColors(colors: { background: string; foreground?: string }): InstanceType<typeof Gtk.TextTag> {
    const key = `tint:${colors.background}|${colors.foreground ?? ''}`;
    return this.tagFor(key, `deco:${this.name}:${key}`, (tag) => {
      (tag as any).backgroundRgba = parseColor(colors.background);
      if (colors.foreground) (tag as any).foregroundRgba = parseColor(colors.foreground);
    });
  }

  /** Get (or lazily create + configure) the tag for `key` (named `name`), raised
   *  above syntax. */
  private tagFor(
    key: string,
    name: string,
    configure: (tag: InstanceType<typeof Gtk.TextTag>) => void,
  ): InstanceType<typeof Gtk.TextTag> {
    let tag = this.tags.get(key);
    if (tag) return tag;
    tag = new Gtk.TextTag({ name } as any);
    configure(tag);
    const table = this.buffer.getTagTable();
    table.add(tag);
    tag.setPriority(table.getSize() - 1); // sit above syntax tags so the decoration wins overlaps
    this.tags.set(key, tag);
    return tag;
  }
}
