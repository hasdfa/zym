/*
 * Peek — a focusable widget shown in a reserved gap below a line, e.g. a
 * see-definition peek that inlines a nested editor. Unlike the diff fold
 * placeholder (a non-interactive `add_overlay` child in the text window, see
 * BlockDecorations), the peek must take keyboard focus — so it lives in the
 * editor's sibling `Gtk.Overlay` (the hover/caret layer host), NOT as a descendant
 * of the GtkTextView. A sibling release the outer view's IM on focus, so typing in
 * the peek doesn't leak into the file behind it (see docs/text-editor/inline-widgets.md).
 *
 * Mechanics (all proven in src/poc/sibling-peek.ts):
 *   - a `pixels-below-lines` tag on the anchor line reserves the gap (real lines part);
 *   - the card is a direct overlay child, positioned at the gap's window coords via
 *     the overlay's `get-child-position` (exact + unclamped, and the overlay only
 *     allocates the card's rect so clicks/scroll outside it reach the file);
 *   - scroll-follow re-runs the overlay allocation on the view's vadjustment change.
 *
 * `get-child-position` requires node-gtk #444 (caller-allocated out-struct signal
 * params). One peek at a time.
 */
import Gtk from 'gi:Gtk-4.0';
import type GtkSource from 'gi:GtkSource-5';
type SourceView = InstanceType<typeof GtkSource.View>;
import { CompositeDisposable } from '../../util/eventKit.ts';

const asIter = (res: any): any => (Array.isArray(res) ? res[1] : res);

export interface PeekOptions {
  /** Anchor line (buffer row); the peek sits below it. */
  line: number;
  widget: InstanceType<typeof Gtk.Widget>;
  /** Reserved gap height = card height, in px. */
  height: number;
  /** Anchor the card at the text-window left (buffer x=0) instead of the anchor line's text x —
   *  so it lines up with `add_overlay`-based block decorations (the diff comment card). */
  alignLeft?: boolean;
  /** Called when the peek is closed (by `close()` or being replaced). */
  onClose?: () => void;
}

interface Current {
  widget: any;
  mark: any; // GtkTextMark at the anchor line
  height: number;
  alignLeft: boolean;
  onClose?: () => void;
}

export class Peek {
  private readonly view: SourceView;
  private readonly overlay: any;
  private readonly buffer: any;
  private readonly gapTag: any;
  private current: Current | null = null;
  private wired = false;
  // The overlay/adjustment handlers wired below capture `this` (→ overlay + view); node-gtk
  // roots them behind a Global handle, so a single un-disconnected one pins this Peek and,
  // through `onClose`, the host editor. `dispose()` (from TextEditor.dispose) severs them.
  private readonly subs = new CompositeDisposable();
  private disposed = false;

  constructor(view: SourceView, overlay: InstanceType<typeof Gtk.Overlay>) {
    this.view = view;
    this.overlay = overlay;
    this.buffer = view.getBuffer();
    this.gapTag = new Gtk.TextTag({ name: 'inline-peek-gap' });
    this.buffer.getTagTable().add(this.gapTag);
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** Open the peek (replacing any current one). */
  show(options: PeekOptions): void {
    this.close();
    this.wireOnce();

    const mark = this.buffer.createMark(null, asIter(this.buffer.getIterAtLine(options.line)), true);
    this.gapTag.pixelsBelowLines = options.height;
    const start = asIter(this.buffer.getIterAtLine(options.line));
    const end = asIter(this.buffer.getIterAtLine(options.line + 1));
    this.buffer.applyTag(this.gapTag, start, end);

    this.current = { widget: options.widget, mark, height: options.height, alignLeft: !!options.alignLeft, onClose: options.onClose };
    this.overlay.addOverlay(options.widget);
    this.view.queueResize();
    this.reposition();
  }

  close(): void {
    if (!this.current) return;
    const { widget, mark, onClose } = this.current;
    this.current = null;
    this.gapTag.pixelsBelowLines = 0;
    this.buffer.removeTag(this.gapTag, this.buffer.getStartIter(), this.buffer.getEndIter());
    this.overlay.removeOverlay(widget);
    this.buffer.deleteMark(mark);
    this.view.queueResize();
    onClose?.();
  }

  // --- internals -------------------------------------------------------------

  /** Re-run the overlay allocation so get-child-position repositions the card. */
  private reposition(): void {
    if (this.current) this.overlay.queueAllocate?.();
  }

  private wireOnce(): void {
    if (this.wired) return;
    this.wired = true;

    // Position the peek at the gap's exact window coords; only the card's rect is
    // allocated, so input outside it passes through to the file. Other overlay
    // children (caret, hover, search bar, …) fall through to default positioning.
    this.subs.connect(this.overlay, 'get-child-position', (child: any, alloc: any) => {
      const cur = this.current;
      if (!cur || child !== cur.widget || !alloc) return false;
      const [x, y] = this.gapWindowXY(cur.mark);
      alloc.x = Math.max(0, Math.round(x));
      alloc.y = Math.round(y);
      alloc.width = Math.max(1, this.view.getWidth() - Math.max(0, Math.round(x)));
      alloc.height = cur.height;
      return true;
    });

    // Scroll-follow. The view's adjustment is the ScrolledWindow's by now (it's
    // already mounted), so this binds the live one.
    const vadj = this.view.getVadjustment?.();
    if (vadj) this.subs.connect(vadj, 'value-changed', () => this.reposition());
  }

  /** Sever the overlay/adjustment handlers (so a closed peek stops pinning the editor)
   *  and drop the gap tag. Called from `TextEditor.dispose()`; idempotent (rule 1). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.subs.dispose();
    this.buffer.getTagTable().remove(this.gapTag);
  }

  /** The gap's top-left in the view's WIDGET coords (scroll-aware). */
  private gapWindowXY(mark: any): [number, number] {
    const iter = asIter(this.buffer.getIterAtMark(mark));
    const loc = this.view.getIterLocation(iter);
    const rect = Array.isArray(loc) ? loc[0] ?? loc[1] : loc;
    // `alignLeft` pins to the text-window left (buffer x=0) to match add_overlay decorations.
    const bufX = this.current?.alignLeft ? 0 : (rect?.x ?? 0);
    const bufY = (rect?.y ?? 0) + (rect?.height ?? 0);
    return this.view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, bufX, bufY);
  }
}
