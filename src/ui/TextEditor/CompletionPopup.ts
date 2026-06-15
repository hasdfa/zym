/*
 * CompletionPopup — the autocompletion dropdown: a list of candidates floated
 * just below the cursor in the editor's `Gtk.Overlay`, optionally with a second
 * pane to its right that shows the selected item's documentation (LSP docs).
 *
 * Keyboard-driven (the editor keeps focus; the `CompletionController` routes
 * Up/Down/Enter via a capture key controller), so the popup itself never takes
 * focus — it just renders the items and tracks the selection. Following the
 * project's floating-UI rule it's a plain overlay card, not a `GtkPopover` (which
 * froze the UI). Positioned by margins + top-left alignment, like the hover card.
 */
import { Gtk, Pango } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { monospaceFontCss, monospaceFontFamily } from '../../fonts.ts';
import { highlightMarkup } from '../Picker.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { iconLabel, completionKindGlyph } from '../icons.ts';
import { markdownToPango } from '../markdownMarkup.ts';
import type { CompletionItem, RankedCompletion } from './CompletionSource.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const POPUP_BG = theme.ui.bg ?? theme.ui.popoverBg ?? '#1e1e1e';
const SELECTED_BG = theme.ui.selectedBg ?? 'rgba(127, 127, 127, 0.25)';
const DETAIL_COLOR = theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg ?? '#888888';
const MONO = monospaceFontCss();
const CODE_FONT_FAMILY = monospaceFontFamily(); // the app's monospace, for doc code spans
const LIST_WIDTH_PX = 420;
const DOC_WIDTH_PX = 440;
const MAX_HEIGHT_PX = 240;
// A row's left structure: card border + row padding + the fixed-width kind-icon
// column + the icon's right margin. `showAt` shifts the popup left by this so the
// *label* (candidate text) — not the icon — lines up under the word being typed.
const BORDER_PX = 1;
const ROW_PADDING_PX = 8;
const ICON_WIDTH_PX = 18;
const ICON_MARGIN_PX = 8;
const LABEL_INSET_PX = BORDER_PX + ROW_PADDING_PX + ICON_WIDTH_PX + ICON_MARGIN_PX;
// Slack for the divider + borders between the list and doc panes.
const DOC_GAP_PX = 14;

addStyles(`
  #CompletionPopup {
    background-color: ${POPUP_BG};
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius-small);
    box-shadow: 0px 6px 20px 8px rgba(0,0,0,0.18);
  }
  /* Inner widgets paint nothing — the card's background shows through, and rows
     get no min-height so a single match is exactly one row tall. */
  #CompletionPopup scrolledwindow,
  #CompletionPopup list,
  #CompletionPopup row {
    background-color: transparent;
    min-height: 0;
  }
  #CompletionPopup row { padding: 1px ${ROW_PADDING_PX}px; }
  #CompletionPopup row:selected { background-color: ${SELECTED_BG}; border-radius: 0; }
  #CompletionPopup .completion-icon { margin-right: ${ICON_MARGIN_PX}px; color: ${DETAIL_COLOR}; opacity: 0.8; }
  #CompletionPopup .completion-label { ${MONO.declarations} }
  #CompletionPopup .completion-detail { opacity: 0.55; margin-left: 0.5em; }
  #CompletionPopup .completion-description { opacity: 0.45; margin-left: 0.75em; font-size: 0.9em; }
  #CompletionPopup separator.completion-divider { background-color: var(--border-color); }
  #CompletionPopup .completion-doc { padding: 6px 8px; }
`);

export class CompletionPopup {
  private readonly panel: InstanceType<typeof Gtk.Box>;
  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly listScroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly divider: InstanceType<typeof Gtk.Separator>;
  private readonly docScroller: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly docLabel: InstanceType<typeof Gtk.Label>;
  private readonly host: Overlay;
  // Syntax-highlight a fenced code block to Pango markup (tree-sitter, supplied by
  // the editor) — same callback the LSP hover uses. Null/absent → plain mono code.
  private readonly highlightCode?: (code: string, lang: string | undefined) => string | null;
  private entries: RankedCompletion[] = [];
  private shown = false;
  // Once any entry's docs have been shown, the doc pane stays open (empty for
  // doc-less entries) so cycling doesn't flicker it open/closed. Reset per show.
  private docPaneSticky = false;

  constructor(
    host: Overlay,
    highlightCode?: (code: string, lang: string | undefined) => string | null,
  ) {
    this.host = host;
    this.highlightCode = highlightCode;
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

    this.listScroller = new Gtk.ScrolledWindow();
    this.listScroller.setChild(this.listBox);
    this.listScroller.setPropagateNaturalHeight(true);
    this.listScroller.setMaxContentHeight(MAX_HEIGHT_PX);
    this.listScroller.setSizeRequest(LIST_WIDTH_PX, -1);

    // Right pane: the selected item's documentation. Hidden until a selected
    // item actually carries `documentation` (so a plain list stays compact).
    this.divider = new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL });
    this.divider.addCssClass('completion-divider');
    this.divider.setVisible(false);

    this.docLabel = new Gtk.Label({ label: '', xalign: 0, yalign: 0, wrap: true });
    this.docLabel.setValign(Gtk.Align.START);
    this.docLabel.addCssClass('completion-doc');
    this.docScroller = new Gtk.ScrolledWindow();
    this.docScroller.setChild(this.docLabel);
    this.docScroller.setPropagateNaturalHeight(true);
    this.docScroller.setMaxContentHeight(MAX_HEIGHT_PX);
    this.docScroller.setSizeRequest(DOC_WIDTH_PX, -1);
    this.docScroller.setVisible(false);

    this.panel = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.panel.setName('CompletionPopup');
    this.panel.setHalign(Gtk.Align.START);
    this.panel.setValign(Gtk.Align.START);
    this.panel.overflow = Gtk.Overflow.HIDDEN;
    this.panel.setCanTarget(false); // keyboard-driven; never steal editor focus
    this.panel.append(this.listScroller);
    this.panel.append(this.divider);
    this.panel.append(this.docScroller);
    this.panel.setVisible(false);
    host.addOverlay(this.panel);
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /** Show `entries` with the list's first row aligned to widget pixel `(x, y)`. */
  showAt(entries: RankedCompletion[], x: number, y: number): void {
    this.entries = entries;
    this.rebuild();
    let left = Math.max(0, Math.round(x) - LABEL_INSET_PX);
    // The doc pane opens to the right when a candidate is selected. Reserve room
    // for it and shift the popup left if the word is near the editor's right edge,
    // so the doc pane doesn't end up clipped off-screen.
    const overlayWidth = this.host.getWidth();
    // Reserve doc-pane room when any entry has docs now or could gain them via a
    // lazy resolve (LSP), so the popup doesn't shift once the pane opens.
    const mayHaveDocs = entries.some((e) => e.item.documentation?.trim() || e.item.resolve);
    const reserved = mayHaveDocs ? LIST_WIDTH_PX + DOC_GAP_PX + DOC_WIDTH_PX : LIST_WIDTH_PX;
    if (overlayWidth > 0 && left + reserved > overlayWidth) {
      left = Math.max(0, overlayWidth - reserved);
    }
    this.panel.setMarginStart(left);
    this.panel.setMarginTop(Math.max(0, Math.round(y)));
    this.panel.setVisible(true);
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.panel.setVisible(false);
  }

  /** Number of candidates. */
  get length(): number {
    return this.entries.length;
  }

  /** The selected row index, or -1 when nothing is selected. */
  getSelectedIndex(): number {
    return this.listBox.getSelectedRow()?.getIndex() ?? -1;
  }

  /**
   * Select the row at `index`, or clear the selection when `index < 0` (the
   * "nothing selected" state). Updates the documentation pane to match.
   */
  select(index: number): void {
    if (index < 0) {
      this.listBox.unselectAll();
    } else {
      const row = this.listBox.getRowAtIndex(index);
      if (row) this.listBox.selectRow(row);
      this.scrollSelectedIntoView();
    }
    this.updateDoc();
  }

  /** Scroll the list so the selected row is visible (the list can hold more
   *  candidates than fit, and the popup never takes focus to auto-scroll). */
  private scrollSelectedIntoView(): void {
    const row = this.listBox.getSelectedRow();
    const adjustment = this.listScroller.getVadjustment();
    if (!row || !adjustment) return;
    let rect;
    try {
      const result: any = (row as any).computeBounds(this.listBox);
      rect = Array.isArray(result) ? result[1] : result;
    } catch {
      return;
    }
    if (!rect) return;
    const top = rect.getY();
    const bottom = top + rect.getHeight();
    const viewTop = adjustment.getValue();
    const viewBottom = viewTop + adjustment.getPageSize();
    if (top < viewTop) adjustment.setValue(top);
    else if (bottom > viewBottom) adjustment.setValue(bottom - adjustment.getPageSize());
  }

  getSelected(): CompletionItem | null {
    const index = this.listBox.getSelectedRow()?.getIndex();
    return index === undefined ? null : (this.entries[index]?.item ?? null);
  }

  /** Re-render the doc pane from the current selection (e.g. after a late
   *  `resolve` filled in its documentation). */
  refreshDoc(): void {
    this.updateDoc();
  }

  private rebuild(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
    for (const entry of this.entries) this.listBox.append(this.buildRow(entry));
    // Start with nothing selected (the -1 state); the first Tab selects row 0.
    this.listBox.unselectAll();
    this.docPaneSticky = false; // fresh list: pane closed until docs appear
    this.updateDoc();
  }

  /** Mirror the selected item's documentation into the side pane. The pane is
   *  sticky: once any entry has shown docs it stays open (empty for doc-less
   *  entries) so cycling doesn't flicker it open and closed. */
  private updateDoc(): void {
    const doc = this.getSelected()?.documentation?.trim();
    if (doc) this.docPaneSticky = true;
    // Render the documentation as markdown (LSP docs are markdown/plaintext), with
    // code spans in the app's monospace font (not Pango's generic one) and fenced
    // blocks tree-sitter highlighted — same as the LSP hover card.
    this.docLabel.setMarkup(
      doc ? markdownToPango(doc, { codeFontFamily: CODE_FONT_FAMILY, highlightCode: this.highlightCode }) : '',
    );
    this.divider.setVisible(this.docPaneSticky);
    this.docScroller.setVisible(this.docPaneSticky);
  }

  private buildRow({ item, positions }: RankedCompletion): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });

    // Muted kind icon (Nerd Font Codicon) in a fixed-width column, like VSCode.
    const icon = iconLabel(completionKindGlyph(item.kind));
    icon.addCssClass('completion-icon');
    icon.setSizeRequest(ICON_WIDTH_PX, -1);
    icon.setXalign(0.5);
    box.append(icon);

    // Label + detail packed together on the left (VSCode style: the detail sits
    // just after the label), in a hexpanding box so the description pins right.
    const main = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    main.setHexpand(true);

    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    // Highlight the fuzzy-matched characters (same accent the picker uses).
    label.setMarkup(highlightMarkup(item.label, positions));
    label.addCssClass('completion-label');
    label.setEllipsize(Pango.EllipsizeMode.END);
    main.append(label);

    if (item.detail) {
      const detail = new Gtk.Label({ xalign: 0, useMarkup: true });
      detail.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.detail)}</span>`);
      detail.addCssClass('completion-detail');
      detail.setEllipsize(Pango.EllipsizeMode.END);
      detail.setMaxWidthChars(40);
      main.append(detail);
    }
    box.append(main);

    // Source module / import path (LSP `labelDetails.description`), dimmed, far right.
    if (item.description) {
      const description = new Gtk.Label({ xalign: 1, useMarkup: true });
      description.setMarkup(`<span foreground="${DETAIL_COLOR}">${escapeMarkup(item.description)}</span>`);
      description.addCssClass('completion-description');
      description.setEllipsize(Pango.EllipsizeMode.END);
      description.setMaxWidthChars(24);
      box.append(description);
    }

    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }
}
