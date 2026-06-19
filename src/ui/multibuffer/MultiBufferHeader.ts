/*
 * MultiBufferHeader — the filename "header" shown above each excerpt in a multibuffer, as a
 * real Gtk widget (icon + dimmed directory + bold basename) rather than a row of buffer text.
 * `MultiBufferView` anchors one above each excerpt's first row via `BlockDecorations` (a
 * reserved band, zero buffer footprint), so the filename isn't navigable/selectable text and
 * doesn't occupy a buffer line. Clicking it jumps to the file (the role Enter-on-the-header
 * row used to play).
 */
import * as Path from 'node:path';
import { Gtk, Pango } from '../../gi.ts';
import { ICON_FONT_FAMILY } from '../../fonts.ts';
import { theme } from '../../theme/theme.ts';
import { addStyles } from '../../styles.ts';
import { fileIconGlyph } from '../fileIcons.ts';
import { escapeMarkup } from '../proseMarkup.ts';

addStyles(`
  .mb-header {
    padding: 2px 8px 2px 6px;
    background-color: ${theme.ui.surface.selected ?? theme.ui.surface.popover};
  }
  .mb-header-icon { color: ${theme.ui.text.muted}; }
  .mb-header-label { color: ${theme.ui.editor.foreground}; }
`);

/** The header widget for one excerpt: `label` is the display path (dir dimmed, basename bold),
 *  `path` selects the file-type icon, `onActivate` fires on click (jump to the file). */
export function buildHeaderWidget(
  label: string,
  path: string,
  onActivate: () => void,
): InstanceType<typeof Gtk.Widget> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  box.addCssClass('mb-header');

  const icon = new Gtk.Label({ label: fileIconGlyph(Path.basename(path), false) });
  const attrs = Pango.AttrList.new();
  attrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  icon.setAttributes(attrs);
  icon.addCssClass('mb-header-icon');
  box.append(icon);

  const name = new Gtk.Label({ xalign: 0, hexpand: true });
  const dir = Path.dirname(label);
  const base = Path.basename(label);
  const dirMarkup = dir && dir !== '.' ? `<span alpha="55%">${escapeMarkup(dir)}/</span>` : '';
  name.setMarkup(`${dirMarkup}<b>${escapeMarkup(base)}</b>`);
  name.addCssClass('mb-header-label');
  box.append(name);

  const click = new Gtk.GestureClick();
  click.on('released', () => onActivate());
  box.addController(click);
  return box;
}
