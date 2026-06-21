/*
 * EditorPopover — a cursor-anchored Gtk.Popover, the shared base for the editor's floating
 * cards (LSP hover, signature help, and the autocompletion list). Centralizes the three
 * things every one of them needs:
 *
 *  - Anchoring: parented to the view, pointed at a buffer position (via the model's
 *    widget-relative pixel rect); GTK flips it above/below to fit the viewport.
 *  - Freeze-safe show: calling Gtk.Popover.popup() inside the promise-continuation
 *    microtask that node-gtk drains under the GLib loop (e.g. after `await lsp.hover()`)
 *    freezes the UI; deferring it onto a libuv tick (setTimeout 0 — the context a
 *    subprocess callback already runs in) is safe.
 *  - Left-alignment: GtkPopover centers on its anchor rect, so to line the card's text up
 *    with the code column we span the anchor rect across the card's *measured* width with
 *    its left edge one chrome-inset left of the point — the centered card then lands there,
 *    correct for any content width.
 *
 * autohide=false throughout: these are informational, keyboard-driven surfaces that must
 * never steal focus from the editor.
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import type { EditorModel } from './EditorModel.ts';

export interface EditorPopoverOptions {
  /** Place the card above ('top', the default) or below ('bottom') the anchor. */
  position?: 'top' | 'bottom';
  /** CSS class applied to the popover. */
  cssClass?: string;
  /** The popover's horizontal chrome (border + contents padding) in px — what sits between
   *  the popover edge and the child. The card shifts left by it so the child's edge, not the
   *  popover's, lands at the anchor; it's also added to the card width. Default 0. */
  chrome?: number;
}

export class EditorPopover {
  readonly popover: InstanceType<typeof Gtk.Popover>;
  private readonly model: EditorModel;
  private readonly child: InstanceType<typeof Gtk.Widget>;
  private readonly chrome: number;
  private showId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    model: EditorModel,
    view: SourceView,
    child: InstanceType<typeof Gtk.Widget>,
    opts: EditorPopoverOptions = {},
  ) {
    this.model = model;
    this.child = child;
    this.chrome = opts.chrome ?? 0;
    this.popover = new Gtk.Popover();
    this.popover.setChild(child);
    this.popover.setAutohide(false); // don't grab — dismissal is driven by the editor
    this.popover.setCanFocus(false); // never move focus off the view (keeps keys flowing)
    this.popover.setFocusable(false);
    this.popover.setHasArrow(false);
    this.popover.setPosition(opts.position === 'bottom' ? Gtk.PositionType.BOTTOM : Gtk.PositionType.TOP);
    if (opts.cssClass) this.popover.addCssClass(opts.cssClass);
    this.popover.setParent(view);
  }

  /** Point the card at buffer `point` and show it, LEFT-aligned: the popover's left edge
   *  lands `chrome + contentInset` left of the point, so the content's anchor — the chrome
   *  plus the child's own left inset (e.g. a completion icon column; default 0) — sits on
   *  the point's column. GtkPopover centers on its anchor rect, so the rect is spanned to
   *  the card's measured width to land that left edge. Returns false if off-screen. */
  showAt(point: { row: number; column: number }, contentInset = 0): boolean {
    if (!this.model.pixelRectForBufferPosition(point)) return false; // off-screen → caller may retry
    // Everything below touches GTK layout (measure() forces a size pass; popup() makes a
    // surface) — run it on a libuv tick, never inside the promise-continuation microtask
    // node-gtk drains under the GLib loop (callers like LSP hover/completion reach here
    // after an `await`), which can freeze. Recompute the rect on the tick so it's current.
    if (this.showId) clearTimeout(this.showId);
    this.showId = setTimeout(() => {
      this.showId = null;
      const rect = this.model.pixelRectForBufferPosition(point);
      if (!rect) return;
      // The popover takes the content's natural width (≥ the child's min) plus its chrome.
      const [min, nat] = this.child.measure(Gtk.Orientation.HORIZONTAL, -1);
      const target = new Gdk.Rectangle();
      target.x = rect.x - this.chrome - contentInset;
      target.y = rect.y;
      target.width = Math.max(min, nat) + 2 * this.chrome;
      target.height = rect.height;
      this.popover.setPointingTo(target);
      this.popover.popup();
    }, 0);
    return true;
  }

  /** Re-show at the last anchor (content changed in place, anchor unchanged). */
  show(): void {
    if (this.showId) clearTimeout(this.showId);
    this.showId = setTimeout(() => {
      this.showId = null;
      this.popover.popup();
    }, 0);
  }

  hide(): void {
    if (this.showId) {
      clearTimeout(this.showId);
      this.showId = null;
    }
    this.popover.popdown();
  }

  get visible(): boolean {
    return this.popover.getVisible();
  }

  dispose(): void {
    this.hide();
    this.popover.unparent(); // a setParent'd popover must be unparented to free it
  }
}
