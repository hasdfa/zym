/*
 * HeaderBands — the filename "header" shown above each excerpt in a multibuffer, as a
 * real Gtk widget (icon + dimmed directory + bold basename) rather than a row of buffer text.
 * `SearchResultsView` anchors one above each excerpt's first row via `BlockDecorations` (a
 * reserved band, zero buffer footprint), so the filename isn't navigable/selectable text and
 * doesn't occupy a buffer line. Clicking it jumps to the file (the role Enter-on-the-header
 * row used to play).
 */
import * as Path from 'node:path';
import { Gtk, Pango } from '../gi.ts';
import type { CompositeDisposable } from '../util/eventKit.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { escapeMarkup } from './proseMarkup.ts';

addStyles(/* css */`
  .mb-header {
    padding: var(--t-spacing) calc(2 * var(--t-spacing));
    background-color: var(--t-ui-editor-background);
    background-image: linear-gradient(rgba(255 255 255 / 16%), rgba(255 255 255 / 16%));
    border-radius: 5px;
  }
  .mb-header-icon { color: var(--t-ui-text-muted); }
  .mb-header-label { color: var(--t-ui-editor-foreground); }
  .mb-header-chevron { color: var(--t-ui-text-muted); }
  .mb-header-add { color: var(--t-ui-status-success); }
  .mb-header-del { color: var(--t-ui-status-error); }
  /* The header whose (read-only) line the caret sits on (sticky-diff navigation) reads as focused.
     The class lands on the .mb-header element itself (the header widget IS the row). */
  .mb-header.mb-header-focused {
    background-image: linear-gradient(rgba(255 255 255 / 26%), rgba(255 255 255 / 26%));
    outline: 1px solid var(--t-ui-text-accent);
    outline-offset: -1px;
  }
  .mb-gap { color: var(--t-ui-text-muted); padding: 1px 8px 1px 6px; }
  /* Every fold marker reads the same grey fill (distinct from the header's selected background),
     whether a between-windows gap or the leading gap above a file's first content row. */
  .mb-gap-band { background-color: rgba(128, 128, 128, 0.15); }
  .mb-gap-clickable:hover { color: var(--t-ui-text-accent); }
`);

/** Optional diff-surface extras on the header: a collapse `chevron` (`▾` expanded / `▸` collapsed)
 *  and the file's `+N −M` change stats. Omitted by the search surface (no chevron/stats). */
export interface HeaderExtras {
  collapsed?: boolean;
  added?: number;
  removed?: number;
}

/** The header widget for one excerpt: `label` is the display path (dir dimmed, basename bold),
 *  `path` selects the file-type icon, `onActivate` fires on click (jump to the file). `extras` adds
 *  the diff's collapse chevron + `+N −M` stats. (A leading `⋯` gap is a SEPARATE gap band — see
 *  `buildGapWidget` — not part of the header.) The header row IS the returned widget. */
export function buildHeaderWidget(
  scope: CompositeDisposable,
  label: string,
  path: string,
  onActivate: () => void,
  extras?: HeaderExtras,
): InstanceType<typeof Gtk.Widget> {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  row.addCssClass('mb-header');
  // Collapse chevron (diff surface): `▾` when the file is expanded, `▸` when collapsed.
  if (extras?.collapsed !== undefined) {
    const chevron = new Gtk.Label({ label: extras.collapsed ? '▸' : '▾' });
    chevron.addCssClass('mb-header-chevron');
    row.append(chevron);
  }
  const icon = new Gtk.Label({ label: fileIconGlyph(Path.basename(path), false) });
  const attrs = Pango.AttrList.new();
  attrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  icon.setAttributes(attrs);
  icon.addCssClass('mb-header-icon');
  row.append(icon);

  const name = new Gtk.Label({ xalign: 0, hexpand: true });
  const dir = Path.dirname(label);
  const base = Path.basename(label);
  const dirMarkup = dir && dir !== '.' ? `<span alpha="55%">${escapeMarkup(dir)}/</span>` : '';
  name.setMarkup(`${dirMarkup}<b>${escapeMarkup(base)}</b>`);
  name.addCssClass('mb-header-label');
  row.append(name);

  // Change stats (diff surface): `+N` added (green), `−M` removed (red).
  if (extras && (extras.added || extras.removed)) {
    if (extras.added) {
      const add = new Gtk.Label({ label: `+${extras.added}` });
      add.addCssClass('mb-header-add');
      row.append(add);
    }
    if (extras.removed) {
      const del = new Gtk.Label({ label: `−${extras.removed}` });
      del.addCssClass('mb-header-del');
      row.append(del);
    }
  }

  // Click the header → jump to the file.
  const click = new Gtk.GestureClick();
  click.on('released', () => onActivate());
  scope.addController(row, click); // severed when this band's widget is dropped (rule 9)
  return row;
}

/** A `⋯ N unchanged lines` gap band — a dim fold marker (not a navigable buffer row), anchored
 *  between two diff windows (or above a file's first content row for the elided head) via
 *  `BlockDecorations`. `onActivate` (click) expands more context. */
export function buildGapWidget(
  scope: CompositeDisposable,
  label: string,
  onActivate?: () => void,
): InstanceType<typeof Gtk.Widget> {
  const widget = new Gtk.Label({ label, xalign: 0 });
  widget.addCssClass('mb-gap');
  widget.addCssClass('mb-gap-band'); // grey fill — the shared fold-marker style
  if (onActivate) {
    widget.addCssClass('mb-gap-clickable');
    const click = new Gtk.GestureClick();
    click.on('released', () => onActivate());
    scope.addController(widget, click); // severed when this band's widget is dropped (rule 9)
  }
  return widget;
}
