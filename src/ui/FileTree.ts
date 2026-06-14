/*
 * FileTree — a lazily-expanding directory tree of a root folder (typically the
 * cwd). Each directory is enumerated in JS into a sorted GListStore (directories
 * first, then by name) which a GtkTreeListModel expands lazily per directory;
 * activating a file row invokes `onOpenFile` with its absolute path, while
 * activating a directory toggles its expansion. The assembled, scrollable tree
 * is exposed via `root`.
 */
import { Gio, GObject, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { fileIconGlyph } from './fileIcons.ts';

// Use the active theme's foreground for tree text/icons (rather than Adwaita's
// default), to match the editor. `#FileTree` is the ScrolledWindow's widget name
// (gtk_widget_set_name → a CSS *id*, not an element name). Target `label`
// directly — Adwaita colors row text on an inner node, so a color on the
// container won't inherit down — and exclude `:selected` rows so the selection
// keeps its own contrast.
addStyles(`
  #FileTree row:not(:selected) label {
    color: ${theme.ui.fg};
  }
`);

const SIDEBAR_ATTRS = 'standard::name,standard::type';
const FILE_INFO_GTYPE = GObject.typeFromName('GFileInfo');

type GFile = ReturnType<typeof Gio.File.newForPath>;

// node-gtk does not expose GFile's interface methods on instances (they resolve
// to undefined on the concrete GLocalFile wrapper), so we reach them through the
// interface prototype. See https://github.com/romgrk/node-gtk for the quirk.
const FileProto = (Gio.File as any).prototype;
const enumerateChildren = (file: GFile): InstanceType<typeof Gio.FileEnumerator> =>
  FileProto.enumerateChildren.call(
    file,
    SIDEBAR_ATTRS,
    Gio.FileQueryInfoFlags.NONE,
    null,
  );
const pathOf = (file: GFile): string | null => FileProto.getPath.call(file);

/**
 * A directory's contents as a model sorted directories-first, then entries
 * ordered case-insensitively by name. GtkCustomSorter can't be used here —
 * node-gtk hands its compare callback untyped `gconstpointer` args (undefined in
 * JS) — so we enumerate and sort in JS into a GListStore instead. Each row's
 * GFile is stashed under `standard::file` for later expansion / opening.
 */
function sortedDirectory(file: GFile): InstanceType<typeof Gio.ListStore> {
  const store = Gio.ListStore.new(FILE_INFO_GTYPE);

  let enumerator: InstanceType<typeof Gio.FileEnumerator>;
  try {
    enumerator = enumerateChildren(file);
  } catch {
    return store; // unreadable directory (e.g. permission denied) → empty
  }

  const infos: Array<InstanceType<typeof Gio.FileInfo>> = [];
  let info: InstanceType<typeof Gio.FileInfo> | null;
  while ((info = enumerator.nextFile(null)) !== null) {
    info.setAttributeObject('standard::file', enumerator.getChild(info) as any);
    infos.push(info);
  }
  enumerator.close(null);

  infos.sort((a, b) => {
    const aDir = a.getFileType() === Gio.FileType.DIRECTORY;
    const bDir = b.getFileType() === Gio.FileType.DIRECTORY;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.getName().toLowerCase().localeCompare(b.getName().toLowerCase());
  });
  for (const each of infos) store.append(each);

  return store;
}

// Vim-style tree navigation, registered once against the `FileTree` selector
// (each tree sets its widget name to "FileTree"), so the CAPTURE-phase keymap
// routes keystrokes to whichever tree holds focus. The `core:*` commands are
// registered per-instance (see registerCommands), so dispatch lands on the
// focused tree.
const NAV_KEYMAP: Record<string, string> = {
  j: 'core:down',
  k: 'core:up',
  l: 'core:right', // enter a directory / open a file
  h: 'core:left',  // collapse a directory / go to parent
};

let keymapRegistered = false;
function ensureKeymap(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  quilx.keymaps.add('FileTree', { FileTree: NAV_KEYMAP });
}

export interface FileTreeOptions {
  rootPath: string;
  onOpenFile: (path: string) => void;
}

export class FileTree {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly list: InstanceType<typeof Gtk.ListView>;
  private readonly tree: InstanceType<typeof Gtk.TreeListModel>;
  private readonly selection: InstanceType<typeof Gtk.SingleSelection>;
  private readonly onOpenFile: (path: string) => void;

  constructor(options: FileTreeOptions) {
    this.onOpenFile = options.onOpenFile;
    const rootList = sortedDirectory(Gio.File.newForPath(options.rootPath));

    const tree = Gtk.TreeListModel.new(rootList, false, false, (item: any) => {
      if (item.getFileType() !== Gio.FileType.DIRECTORY) return null;
      return sortedDirectory(item.getAttributeObject('standard::file') as any);
    });
    const selection = new Gtk.SingleSelection({ model: tree });

    // Each row is a TreeExpander (for the disclosure triangle) wrapping a box of
    // [icon label, name label]. The icon is a Nerd Font glyph rendered in the
    // bundled icon font; as plain label text it inherits the theme foreground
    // color (so icons are monochrome and follow light/dark themes).
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(
      Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)),
    );

    const factory = new Gtk.SignalListItemFactory();
    factory.on('setup', (listItem: any) => {
      const expander = new Gtk.TreeExpander();
      const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const icon = new Gtk.Label({ xalign: 0 });
      icon.setAttributes(iconAttrs);
      box.append(icon);
      box.append(new Gtk.Label({ xalign: 0 }));
      expander.setChild(box);
      listItem.setChild(expander);
    });
    factory.on('bind', (listItem: any) => {
      const row = listItem.getItem();
      const expander = listItem.getChild();
      expander.setListRow(row);

      const info = row.getItem();
      const box = expander.getChild();
      const iconLabel = box.getFirstChild();
      const nameLabel = box.getLastChild();

      const name = info.getName();
      const isDir = info.getFileType() === Gio.FileType.DIRECTORY;
      iconLabel.setText(fileIconGlyph(name, isDir));
      nameLabel.setText(name);
    });

    const list = new Gtk.ListView({ model: selection, factory });
    list.on('activate', (position: number) => {
      const row = tree.getRow(position);
      if (row) this.activateRow(row);
    });

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setName('FileTree'); // selector identity for command/keymap rules
    scrolled.setChild(list);
    scrolled.setVexpand(true);
    this.root = scrolled;
    this.list = list;
    this.tree = tree;
    this.selection = selection;

    ensureKeymap();
    this.registerCommands();
  }

  /** Move keyboard focus into the tree. */
  focus() {
    this.list.grabFocus();
  }

  // --- Navigation ----------------------------------------------------------

  private registerCommands(): void {
    quilx.commands.add(this.root, {
      'core:down': () => this.move(+1),
      'core:up': () => this.move(-1),
      'core:right': () => this.enter(),
      'core:left': () => this.exit(),
    });
  }

  /** Select (and scroll/focus) the row `delta` steps from the current one. */
  private move(delta: number): void {
    const pos = this.selection.getSelected();
    this.select(pos === Gtk.INVALID_LIST_POSITION ? 0 : pos + delta);
  }

  /** Enter the selected row: expand a directory (or step into an open one),
   *  or open a file. */
  private enter(): void {
    const pos = this.selection.getSelected();
    if (pos === Gtk.INVALID_LIST_POSITION) return this.select(0);
    const row = this.tree.getRow(pos);
    if (!row) return;
    if (this.isDirectory(row)) {
      if (!row.getExpanded()) row.setExpanded(true);
      else this.select(pos + 1); // already open → step into first child
    } else {
      this.openFile(row);
    }
  }

  /** Exit the selected row: collapse an open directory, else jump to the parent. */
  private exit(): void {
    const pos = this.selection.getSelected();
    if (pos === Gtk.INVALID_LIST_POSITION) return;
    const row = this.tree.getRow(pos);
    if (!row) return;
    if (this.isDirectory(row) && row.getExpanded()) {
      row.setExpanded(false);
    } else {
      const parent = row.getParent();
      if (parent) this.select(parent.getPosition());
    }
  }

  /** Activate (Enter / double-click): toggle a directory, or open a file. */
  private activateRow(row: InstanceType<typeof Gtk.TreeListRow>): void {
    if (this.isDirectory(row)) row.setExpanded(!row.getExpanded());
    else this.openFile(row);
  }

  private openFile(row: InstanceType<typeof Gtk.TreeListRow>): void {
    const info: any = row.getItem();
    const path = pathOf(info.getAttributeObject('standard::file') as any);
    if (path) this.onOpenFile(path);
  }

  private isDirectory(row: InstanceType<typeof Gtk.TreeListRow>): boolean {
    return (row.getItem() as any).getFileType() === Gio.FileType.DIRECTORY;
  }

  /** Clamp `pos` into range, select it, and scroll it into view with focus. */
  private select(pos: number): void {
    const n = this.tree.getNItems();
    if (n === 0) return;
    const clamped = Math.max(0, Math.min(pos, n - 1));
    this.selection.setSelected(clamped);
    this.list.scrollTo(clamped, Gtk.ListScrollFlags.FOCUS, null);
  }
}
