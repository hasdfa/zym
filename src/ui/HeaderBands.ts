/*
 * HeaderBands — the filename "header" shown above each excerpt in a multibuffer, as a
 * real Gtk widget rather than a row of buffer text. Two looks share one builder:
 * `SearchResultsView` shows a file-type icon + dimmed directory + bold basename; `DiffView`
 * drops the icon and bolds the whole path uniformly, turning it warning-coloured with a
 * leading dot when the file has unsaved edits (`HeaderWidgetOptions`).
 * The band is anchored above each excerpt's first row via `BlockDecorations` (a reserved band,
 * zero buffer footprint), so the filename isn't navigable/selectable text and doesn't occupy a
 * buffer line. Clicking it jumps to the file (the role Enter-on-the-header row used to play).
 */
import * as Path from 'node:path';
import { Gtk } from '../gi.ts';
import type { CompositeDisposable } from '../util/eventKit.ts';
import { addStyles } from '../styles.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons, iconLabel } from './icons.ts';
import { escapeMarkup } from './proseMarkup.ts';

addStyles(`
  .mb-header {
    margin: var(--t-spacing) 0;
    padding: var(--t-spacing) calc(2 * var(--t-spacing));
    background-color: rgba(255 255 255 / 16%);
    border-radius: 5px;
  }
  .mb-header-icon { color: var(--t-ui-text-muted); }
  .mb-header-label { color: var(--t-ui-editor-foreground); }
  /* An unsaved (modified) diff file: warning-coloured path led by a warning dot. */
  .mb-header-modified { color: var(--t-ui-status-warning); }
  .mb-gap { color: var(--t-ui-text-muted); padding: 1px 8px 1px 6px; }
  /* Every fold marker reads the same: a grey fill (distinct from the header's selected
     background), whether it's a standalone between-windows gap or the leading gap that sits
     directly under a header. */
  .mb-gap-band { background-color: rgba(128, 128, 128, 0.15); }
  .mb-gap-clickable:hover { color: var(--t-ui-text-accent); }
`);

/** Per-header look. The defaults reproduce `SearchResultsView`'s header (file-type icon, dimmed
 *  directory, bold basename); `DiffView` overrides them. */
export interface HeaderWidgetOptions {
  /** Lead the filename with its file-type glyph (default true); the diff header opts out. */
  icon?: boolean;
  /** Bold the whole path uniformly instead of dimming the directory and bolding only the
   *  basename (default false). */
  boldPath?: boolean;
  /** A modified (unsaved) file: the path turns warning-coloured and is led by a warning dot,
   *  replacing the file-type glyph (default false). */
  modified?: boolean;
}

/** The header widget for one excerpt: `label` is the display path, `path` selects the file-type
 *  icon, `onActivate` fires on click (jump to the file). `subtitle` (a diff's leading `⋯` gap)
 *  renders a fold-marker band directly beneath the filename — styled exactly like every other gap
 *  band (not as part of the header), with `onExpand` revealing more context on click. `options`
 *  picks the look (see `HeaderWidgetOptions`). */
export function buildHeaderWidget(
  scope: CompositeDisposable,
  label: string,
  path: string,
  onActivate: () => void,
  subtitle?: string,
  onExpand?: () => void,
  options: HeaderWidgetOptions = {},
): InstanceType<typeof Gtk.Widget> {
  // The outer container is transparent: the header's selected background lives on the filename
  // row only, so a leading gap stacked below it keeps its own fold-marker style.
  const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  row.addCssClass('mb-header');
  // A modified file is flagged by a warning dot; otherwise the file-type glyph leads the name
  // (the diff header opts out of the glyph entirely).
  if (options.modified) {
    const dot = iconLabel(Icons.modified);
    dot.addCssClass('mb-header-modified');
    row.append(dot);
  } else if (options.icon !== false) {
    const icon = iconLabel(fileIconGlyph(Path.basename(path), false));
    icon.addCssClass('mb-header-icon');
    row.append(icon);
  }

  const name = new Gtk.Label({ xalign: 0, hexpand: true });
  if (options.boldPath) {
    name.setMarkup(`<b>${escapeMarkup(label)}</b>`); // whole path, one uniform highlight
  } else {
    const dir = Path.dirname(label);
    const base = Path.basename(label);
    const dirMarkup = dir && dir !== '.' ? `<span alpha="55%">${escapeMarkup(dir)}/</span>` : '';
    name.setMarkup(`${dirMarkup}<b>${escapeMarkup(base)}</b>`);
  }
  name.addCssClass(options.modified ? 'mb-header-modified' : 'mb-header-label');
  row.append(name);

  // Click the filename row → jump to the file (scoped to the row so the leading gap's own click
  // expands context instead of jumping).
  const click = new Gtk.GestureClick();
  click.on('released', () => onActivate());
  scope.addController(row, click); // severed when this band's widget is dropped (rule 9)
  outer.append(row);

  if (subtitle) outer.append(buildGapWidget(scope, subtitle, onExpand));
  return outer;
}

/** A `⋯ N unchanged lines` gap band — a dim fold marker (not a navigable buffer row), anchored
 *  between two diff windows via `BlockDecorations`, or stacked under a header for a leading gap.
 *  `onActivate` (click) expands more context. */
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
