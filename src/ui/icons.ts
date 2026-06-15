/*
 * icons.ts — Nerd Font icon glyphs and a helper to render them.
 *
 * Project convention: all UI icons are Nerd Font glyphs from the bundled
 * "Symbols Nerd Font Mono" (see fonts.ts), rendered as text so they are
 * monochrome, follow the theme foreground via CSS `color`, and don't depend on
 * the system icon theme. Prefer this over `Gio.ThemedIcon` / `Gtk.Image(iconName)`.
 * Even Adw tab icons use a glyph embedded in the tab title (the bundled font is
 * in the default fontmap, so Pango resolves the glyph via substitution).
 *
 * Glyphs are FontAwesome/Octicon codepoints (present in the Nerd Font); file-type
 * icons live separately in fileIcons.ts.
 */
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';

export const Icons = {
  info: String.fromCodePoint(0xf05a), // info-circle
  success: String.fromCodePoint(0xf058), // check-circle
  warning: String.fromCodePoint(0xf071), // exclamation-triangle
  error: String.fromCodePoint(0xf06a), // exclamation-circle
  fatal: String.fromCodePoint(0xf057), // times-circle
  trace: String.fromCodePoint(0xf188), // bug
  close: String.fromCodePoint(0xf00d), // times
  git: String.fromCodePoint(0xf418), // git-branch (matches the header BranchButton)
  modified: String.fromCodePoint(0xf444), // dot-fill — unsaved/modified marker
} as const;

// One shared, immutable attribute list applying the icon font (built lazily so it
// isn't created at import time, before fonts are registered).
let iconAttrs: InstanceType<typeof Pango.AttrList> | null = null;
function attrs(): InstanceType<typeof Pango.AttrList> {
  if (!iconAttrs) {
    iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  }
  return iconAttrs;
}

/** A Gtk.Label rendering `glyph` in the bundled Nerd Font. */
export function iconLabel(glyph: string): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ label: glyph });
  label.setAttributes(attrs());
  return label;
}
