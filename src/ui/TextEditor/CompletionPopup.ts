/*
 * CompletionPopup — the autocompletion dropdown: a list of candidates floated
 * just below the cursor in the editor's `Gtk.Overlay`.
 *
 * Keyboard-driven (the editor keeps focus; the `CompletionController` routes
 * Up/Down/Enter via a capture key controller), so the popup itself never takes
 * focus — it just renders the items and tracks the selection. Following the
 * project's floating-UI rule it's a plain overlay card, not a `GtkPopover` (which
 * froze the UI). Positioned by margins + top-left alignment, like the hover card.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { monospaceFontCss } from '../../fonts.ts';
import { escapeMarkup } from '../Picker.ts';
import type { CompletionItem } from './CompletionSource.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const POPOVER_BG = theme.ui.popoverBg ?? theme.ui.bg ?? '#1e1e1e';
const DETAIL_COLOR = theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg ?? '#888888';
const MONO = monospaceFontCss();
const WIDTH_PX = 340;
const MAX_HEIGHT_PX = 240;

addStyles(`
  #CompletionPopup {
    background-color: ${POPOVER_BG};
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    box-shadow: 0px 6px 20px 8px rgba(0,0,0,0.18);
  }
  #CompletionPopup row { padding: 1px 8px; }
  #CompletionPopup .completion-label { ${MONO.declarations} }
  #CompletionPopup .completion-detail { opacity: 0.6; margin-left: 1em; }
`);

export class CompletionPopup {
  private readonly panel: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private items: CompletionItem[] = [];
  private shown = false;

  constructor(host: Overlay) {
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.listBox);
    scrolled.setPropagateNaturalHeight(true);
    scrolled.setMaxContentHeight(MAX_HEIGHT_PX);

    this.panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.panel.setName('CompletionPopup');
    this.panel.setHalign(Gtk.Align.START);
    this.panel.setValign(Gtk.Align.START);
    this.panel.setSizeRequest(WIDTH_PX, -1);
    this.panel.overflow = Gtk.Overflow.HIDDEN;
    this.panel.setCanTarget(false); // keyboard-driven; never steal editor focus
    this.panel.append(scrolled);
    this.panel.setVisible(false);
    host.addOverlay(this.panel);
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /** Show `items` with the popup's top-left at widget pixel `(x, y)`. */
  showAt(items: CompletionItem[], x: number, y: number): void {
    this.items = items;
    this.rebuild();
    this.panel.setMarginStart(Math.max(0, Math.round(x)));
    this.panel.setMarginTop(Math.max(0, Math.round(y)));
    this.panel.setVisible(true);
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.panel.setVisible(false);
  }

  /** Move the selection by `delta`, wrapping. (The controller caps the list to a
   *  count that fits, so no scroll-into-view — which would need to steal focus.) */
  move(delta: number): void {
    if (this.items.length === 0) return;
    const current = this.listBox.getSelectedRow()?.getIndex() ?? 0;
    const next = (current + delta + this.items.length) % this.items.length;
    const row = this.listBox.getRowAtIndex(next);
    if (row) this.listBox.selectRow(row);
  }

  getSelected(): CompletionItem | null {
    const index = this.listBox.getSelectedRow()?.getIndex();
    return index === undefined ? null : (this.items[index] ?? null);
  }

  private rebuild(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    for (const item of this.items) this.listBox.append(this.buildRow(item));
    const first = this.listBox.getRowAtIndex(0);
    if (first) this.listBox.selectRow(first);
  }

  private buildRow(item: CompletionItem): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    const label = new Gtk.Label({ label: item.label, xalign: 0 });
    label.addCssClass('completion-label');
    box.append(label);
    if (item.detail) {
      const detail = new Gtk.Label({ label: item.detail, xalign: 1, useMarkup: true });
      detail.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.detail)}</span>`);
      detail.setHexpand(true);
      detail.addCssClass('completion-detail');
      box.append(detail);
    }
    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }
}
