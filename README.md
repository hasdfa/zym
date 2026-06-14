# quilx

A modal source-code editor built with [GtkSourceView 5](https://gitlab.gnome.org/GNOME/gtksourceview),
GTK 4 and [Adwaita](https://gnome.pages.gitlab.gnome.org/libadwaita/), running on
[node-gtk](https://github.com/romgrk/node-gtk).

## Features

- **Vim-style modal editing** via `GtkSource.VimIMContext`, with a status line
  showing the command bar (`:`, `/`) and pending command preview (e.g. `2dw`)
- Syntax highlighting with automatic language detection
- Adwaita light/dark style schemes that follow the system preference, plus a
  toolbar toggle to force dark mode
- Open / Save / Save-As through the native `Gtk.FileDialog`
- A source-map (minimap) gutter on the right
- Keyboard shortcuts: `Ctrl+O` open, `Ctrl+S` save, `Ctrl+Shift+S` save-as,
  `Ctrl+Q` quit

## Requirements

- Node.js and [pnpm](https://pnpm.io)
- GTK 4, libadwaita, and GtkSourceView 5 with their GObject-Introspection
  typelibs installed (`Gtk-4.0`, `Adw-1`, `GtkSource-5`)

## Setup

`node-gtk` is consumed as a local linked dependency (`link:../node-gtk`), so a
checkout of [node-gtk](https://github.com/romgrk/node-gtk) must sit alongside
this project:

```
src/
├── node-gtk/
└── quilx/
```

Then install:

```sh
pnpm install
```

## Usage

```sh
pnpm start [file]
# or
node src/editor.js [file]
```

With no argument, quilx opens its own source. In the editor, normal mode is
active by default — press `i` to insert, `Esc` to return to normal mode, and use
`:w`, `:e <path>`, `:q`, `:wq` as you would in Vim.

## License

[GPL-3.0-or-later](LICENSE).

The tree-sitter highlight queries under `src/syntax/queries/` are vendored from
[Zed](https://github.com/zed-industries/zed) (`crates/grammars/src/`), which are
licensed GPL-3.0. Bundling them is why quilx as a whole is distributed under the
GPL.
