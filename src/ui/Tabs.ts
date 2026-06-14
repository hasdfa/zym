/*
 * Tabs — an Adw.TabView + Adw.TabBar holding one TextEditor per tab. Opening a
 * file creates a TextEditor, adds a page titled by the editor, and selects it;
 * closing the last tab fires `onEmpty`. The active editor is tracked so the
 * window can route save/title/status to it. The assembled widget is `root`.
 *
 * This is the content of a center panel. When split logic lands, each split
 * panel will own its own independent Tabs (VS Code-style editor groups).
 */
import { Adw, Gtk } from '../gi.ts';
import { TextEditor } from './TextEditor.ts';

export interface TabsOptions {
  /** Surface a load/save message from any editor. */
  onToast?: (message: string) => void;
  /** Fired when the selected tab changes. */
  onActiveChanged?: (editor: TextEditor | null) => void;
  /** Fired right after a new editor is created (for wiring window-level state). */
  onOpen?: (editor: TextEditor) => void;
  /** Fired when the last tab closes. */
  onEmpty?: () => void;
}

export class Tabs {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly options: TabsOptions;
  private readonly view: InstanceType<typeof Adw.TabView>;
  private readonly editors = new Map<any, TextEditor>(); // TabPage → editor

  constructor(options: TabsOptions = {}) {
    this.options = options;
    this.view = new Adw.TabView();
    this.view.setVexpand(true);

    const bar = new Adw.TabBar();
    bar.setView(this.view);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.append(bar);
    this.root.append(this.view);

    this.view.on('notify::selected-page', () => {
      this.options.onActiveChanged?.(this.activeEditor);
    });
    this.view.on('page-detached', (page: any) => {
      this.editors.delete(page);
      if (this.view.getNPages() === 0) this.options.onEmpty?.();
    });
  }

  /** Open `path` in a new tab and select it. */
  openFile(path: string): TextEditor {
    const editor = new TextEditor({
      onToast: this.options.onToast,
      onClose: () => this.requestClose(editor),
    });
    // Let the window wire status/title handlers before the first title change.
    this.options.onOpen?.(editor);

    const page = this.view.append(editor.root);
    this.editors.set(page, editor);
    page.setTitle(editor.title);
    editor.onTitleChange(() => page.setTitle(editor.title));

    editor.loadFile(path);
    this.view.setSelectedPage(page);
    editor.focus();
    return editor;
  }

  get activeEditor(): TextEditor | null {
    const page = this.view.getSelectedPage();
    return page ? this.editors.get(page) ?? null : null;
  }

  private requestClose(editor: TextEditor) {
    for (const [page, candidate] of this.editors) {
      if (candidate === editor) {
        this.view.closePage(page);
        return;
      }
    }
  }
}
