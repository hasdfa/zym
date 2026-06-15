# General

- This project uses `node-gtk`. In development, it's checked out at `../node-gtk` and linked using `pnpm link`.
- Filenames use camel case:
  - if the file is a component, it should be named after the component, so `ChatMessage.ts` for a `ChatMessage` component.
  - if the file is a utility, it should be named after the utility, so `createChatMessage.ts` for a `createChatMessage` function.
- Read ./tasks/index.md

# UI Components

- Components are built using GTK4 and libadwaita, and are styled using CSS.
- Components should be one main component per file, in the `src/ui` directory.
- Icons: use Nerd Font glyphs (bundled "Symbols Nerd Font Mono"), rendered as
  text — `iconLabel()` / `Icons` in `src/ui/icons.ts`, or `fileIconGlyph()` for
  file types. Do NOT use `Gio.ThemedIcon` / `Gtk.Image(iconName)`. Adw tab icons
  can't take a font glyph in their GIcon slot, so embed the glyph in the tab
  title instead (Pango resolves it from the default fontmap).
- If you need to do styling, read the docs:
  - https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/css-variables.html
