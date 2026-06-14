/*
 * Panel — a generic content host. Holds one child widget (a tabs container, a
 * file tree, a terminal later, …) inside an Adw.Bin, exposed via `root`. Kept
 * deliberately thin: future per-panel chrome (title bar, close/split controls)
 * will live here.
 */
import { Adw, Gtk } from '../gi.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export class Panel {
  readonly root: InstanceType<typeof Adw.Bin>;

  constructor(content?: Widget) {
    this.root = new Adw.Bin();
    if (content) this.root.setChild(content);
  }

  setContent(content: Widget | null) {
    this.root.setChild(content);
  }
}
