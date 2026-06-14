/*
 * FileTree — a lazily-expanding directory tree of a root folder (typically the
 * cwd). A GtkDirectoryList feeds a GtkTreeListModel whose rows reveal a fresh
 * DirectoryList per directory; activating a file row invokes `onOpenFile` with
 * its absolute path, while activating a directory toggles its expansion. The
 * assembled, scrollable tree is exposed via `root`.
 */
import { Gio, Gtk } from '../gi.ts';

const SIDEBAR_ATTRS = 'standard::name,standard::type';

export interface FileTreeOptions {
  rootPath: string;
  onOpenFile: (path: string) => void;
}

export class FileTree {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly list: InstanceType<typeof Gtk.ListView>;

  constructor(options: FileTreeOptions) {
    const dirList = new Gtk.DirectoryList({ attributes: SIDEBAR_ATTRS });
    dirList.setFile(Gio.File.newForPath(options.rootPath));

    const tree = Gtk.TreeListModel.new(dirList, false, false, (item: any) => {
      if (item.getFileType() !== Gio.FileType.DIRECTORY) return null;
      const children = new Gtk.DirectoryList({ attributes: SIDEBAR_ATTRS });
      children.setFile(item.getAttributeObject('standard::file') as any);
      return children;
    });
    const selection = new Gtk.SingleSelection({ model: tree });

    // Each row is a TreeExpander (for the disclosure triangle) wrapping a label.
    const factory = new Gtk.SignalListItemFactory();
    factory.on('setup', (listItem: any) => {
      const expander = new Gtk.TreeExpander();
      expander.setChild(new Gtk.Label({ xalign: 0 }));
      listItem.setChild(expander);
    });
    factory.on('bind', (listItem: any) => {
      const row = listItem.getItem();
      const expander = listItem.getChild();
      expander.setListRow(row);
      expander.getChild().setText(row.getItem().getName());
    });

    const list = new Gtk.ListView({ model: selection, factory });
    list.on('activate', (position: number) => {
      const row = tree.getRow(position);
      if (!row) return;
      const info: any = row.getItem();
      if (info.getFileType() === Gio.FileType.DIRECTORY) {
        row.setExpanded(!row.getExpanded());
      } else {
        const path = (info.getAttributeObject('standard::file') as any)?.getPath();
        if (path) options.onOpenFile(path);
      }
    });

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(list);
    scrolled.setVexpand(true);
    this.root = scrolled;
    this.list = list;
  }

  /** Move keyboard focus into the tree. */
  focus() {
    this.list.grabFocus();
  }
}
