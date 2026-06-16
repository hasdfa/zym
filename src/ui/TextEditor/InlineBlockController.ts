/*
 * InlineBlockController — show a real widget *between* buffer lines with zero
 * buffer footprint (no synthesized text line). The "proper" virtual-line
 * mechanism from tasks/code-editing/inline-widgets.md, proven in
 * src/poc/inline-overlay.ts.
 *
 * How it works (per block):
 *   1. A `Gtk.TextTag` with `pixels-below-lines` (or `-above-`) = the widget's
 *      measured height, applied to the anchor line, reserves a blank band.
 *   2. `gtk_text_view_add_overlay(child, x, y)` drops the widget into that band at
 *      a *buffer* coordinate — so it scrolls with the text for free.
 *   3. A `GtkTextMark` tracks the anchor line across edits; `get_iter_location`
 *      gives its pixel rect (buffer coords) to position the overlay.
 *
 * Scope: this is the **non-interactive / click-only** path (`add_overlay` children
 * are descendants of the text view, so a focusable nested *editor* leaks IM input
 * — see inline-widgets.md). Clickable widgets (the fold placeholder, code-lens
 * buttons) and drawn content work; a focusable peek editor uses the planned
 * sibling-overlay variant instead.
 *
 * The view must be **mapped** before an overlay is placed (pre-realize geometry is
 * 0); `add()` before map defers placement to the `map` signal. Layout changes that
 * move anchors (edits, fold toggles) aren't auto-followed — call `repositionAll()`.
 */
import { Gtk, GLib, type SourceView } from '../../gi.ts';

export type InlineBlockPlacement = 'below' | 'above';

export interface InlineBlockOptions {
  /** Anchor line (buffer row). The band sits below it ('below') or above it ('above'). */
  line: number;
  widget: InstanceType<typeof Gtk.Widget>;
  placement?: InlineBlockPlacement;
}

export interface InlineBlockHandle {
  /** Remove the band + overlay and drop the anchor mark. */
  remove(): void;
  /** Re-measure the widget height and reposition (after the widget's size changes). */
  invalidate(): void;
}

interface Block {
  mark: any; // GtkTextMark at the anchor line start
  tag: any; // per-block gap tag
  widget: any;
  placement: InlineBlockPlacement;
  height: number;
  placed: boolean; // overlay added to the view yet (deferred until mapped)
  lastY: number; // last buffer-Y the overlay was moved to (skip no-op moves)
}

// Frames to keep repositioning after a layout-changing event (fold toggle, edit).
// A tick callback runs each frame; geometry settles within a couple, then it stops.
const REPOSITION_FRAMES = 6;

/** getIter*, defensively unwrapping node-gtk's [ok, iter] return shape. */
const unwrap = (res: any): any => (Array.isArray(res) ? res[1] : res);

export class InlineBlockController {
  private readonly view: SourceView;
  private readonly buffer: any;
  private readonly blocks = new Set<Block>();
  private nextTagId = 0;
  private flushPending = false;
  private repositionTickId = 0;
  private repositionFrames = 0;
  private vadjHooked = false;

  constructor(view: SourceView) {
    this.view = view;
    this.buffer = (view as any).getBuffer();

    // Place any blocks added before the view was mapped. `map` fires before the
    // first layout pass, so line geometry (get_iter_location) is still 0 — defer
    // and retry until it's valid (see scheduleFlush).
    (view as any).on('map', () => {
      this.scheduleFlush(0);
      this.hookVadjustment();
    });
  }

  /** Reposition whenever the content height changes — a fold collapse/expand, an
   *  edit, or a window resize moves anchors. The vadjustment's `changed` fires
   *  after allocation (fresh geometry); we defer to idle to avoid repositioning
   *  mid-allocation. This is what keeps a band aligned after a fold toggle. */
  private hookVadjustment(): void {
    if (this.vadjHooked) return;
    const vadj = (this.view as any).getVadjustment?.();
    if (!vadj) return;
    this.vadjHooked = true;
    vadj.on('changed', () => this.scheduleReposition());
  }

  add(options: InlineBlockOptions): InlineBlockHandle {
    const placement = options.placement ?? 'below';
    const lineIter = unwrap(this.buffer.getIterAtLine(options.line));
    const block: Block = {
      mark: this.buffer.createMark(null, lineIter, true /* left gravity: stay at line start */),
      tag: new Gtk.TextTag({ name: `inline-block:${this.nextTagId++}` } as any),
      widget: options.widget,
      placement,
      height: 0,
      placed: false,
      lastY: NaN,
    };
    (this.buffer.getTagTable() as any).add(block.tag);
    this.blocks.add(block);

    // Always place from the deferred flush, never synchronously — even when mapped.
    // A block added during a fold toggle runs right after the body's invisible-tag
    // change invalidated the layout; placing (addOverlay) synchronously then leaves
    // the overlay child unallocated until an external relayout. Deferring lets the
    // invalidation settle first (this is the path the initial placement uses).
    this.scheduleFlush(0);

    return {
      remove: () => this.removeBlock(block),
      invalidate: () => {
        if (block.placed) this.place(block);
      },
    };
  }

  /** Reposition every placed block — call after layout shifts an anchor (a fold
   *  toggle, an edit above a block); `add_overlay` follows scroll but not these.
   *  Deferred to idle: the triggering change (e.g. a fold's invisible tag) hasn't
   *  re-validated line geometry yet, so reading get_iter_location now is stale. */
  repositionAll(): void {
    this.scheduleReposition();
  }

  // --- internals -------------------------------------------------------------

  /** Reposition every placed block once per frame for a short window, then stop.
   *  A layout-changing event (fold toggle) settles over a frame or two, and a tick
   *  callback runs in sync with the frame clock — so each pass reads progressively
   *  fresher geometry (vs. an idle/timeout, which fires at an unpredictable point in
   *  node-gtk's cooperative loop and can read mid-transition coordinates). */
  private scheduleReposition(): void {
    this.repositionFrames = 0; // (re)start the settle window
    if (this.repositionTickId) return; // a tick is already running
    this.repositionTickId = (this.view as any).addTickCallback(() => {
      for (const block of this.blocks) if (block.placed) this.reposition(block);
      if (++this.repositionFrames >= REPOSITION_FRAMES) {
        this.repositionTickId = 0;
        return false; // G_SOURCE_REMOVE
      }
      return true; // G_SOURCE_CONTINUE
    });
  }

  /** Retry placing unplaced blocks until the view has validated line geometry
   *  (get_iter_location returns a non-zero height). One timer at a time; ~one frame
   *  apart, capped so a never-ready view can't spin forever. */
  private scheduleFlush(tries: number): void {
    if (this.flushPending) return;
    this.flushPending = true;
    GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 16, () => {
      this.flushPending = false;
      let allReady = true;
      for (const block of this.blocks) {
        if (block.placed) continue;
        if (this.lineRect(this.markLine(block)).height === 0) allReady = false;
        else this.place(block);
      }
      if (!allReady && tries < 30) this.scheduleFlush(tries + 1);
      return false; // GLib.SOURCE_REMOVE
    });
  }

  private markLine(block: Block): number {
    return unwrap(this.buffer.getIterAtMark(block.mark)).getLine();
  }

  /** Anchor line's pixel rect (buffer coords). */
  private lineRect(line: number): { y: number; height: number } {
    const iter = unwrap(this.buffer.getIterAtLine(line));
    const loc = (this.view as any).getIterLocation(iter);
    const rect = Array.isArray(loc) ? loc[0] ?? loc[1] : loc;
    return { y: rect?.y ?? 0, height: rect?.height ?? 0 };
  }

  /** First add: measure the widget, reserve the band, add the overlay. No-ops (and
   *  reschedules) until the view has validated line geometry. */
  private place(block: Block): void {
    const line = this.markLine(block);
    if (this.lineRect(line).height === 0) {
      this.scheduleFlush(0); // geometry not ready (pre-first-draw) — retry
      return;
    }

    // Add the overlay first so the widget is parented and can measure correctly.
    if (!block.placed) {
      (this.view as any).addOverlay(block.widget, 0, this.lineRect(line).y);
      block.placed = true;
    }

    block.height = Math.max(1, (block.widget.measure(Gtk.Orientation.VERTICAL, -1) as any)[1]);

    // Reserve the band on the anchor line (re-applied each place in case it moved).
    const prop = block.placement === 'below' ? 'pixelsBelowLines' : 'pixelsAboveLines';
    (block.tag as any)[prop] = block.height;
    const start = unwrap(this.buffer.getIterAtLine(line));
    const end = unwrap(this.buffer.getIterAtLine(line + 1)); // ok: anchors aren't the last line
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    this.buffer.applyTag(block.tag, start, end);

    // Force a re-allocation: under node-gtk's cooperative loop, adding the overlay
    // and changing the gap tag don't otherwise trigger size_allocate, so the gap
    // stays unreserved and the overlay child unallocated (invisible) until some
    // external event (e.g. a window resize) forces a relayout.
    (this.view as any).queueResize?.();
    this.reposition(block);
  }

  private reposition(block: Block): void {
    const rect = this.lineRect(this.markLine(block));
    if (rect.height === 0) return; // geometry momentarily invalid — keep last position
    // 'below': band starts at the anchor's bottom. 'above': the tag pushed the anchor
    // down by `height`, so the band is the `height` px above its new top.
    const y = block.placement === 'below' ? rect.y + rect.height : rect.y - block.height;
    if (y === block.lastY) return; // no-op move (avoids churn during the settle window)
    block.lastY = y;
    (this.view as any).moveOverlay(block.widget, 0, y);
  }

  private removeBlock(block: Block): void {
    if (!this.blocks.delete(block)) return;
    this.buffer.removeTag(block.tag, this.buffer.getStartIter(), this.buffer.getEndIter());
    (this.buffer.getTagTable() as any).remove(block.tag);
    this.buffer.deleteMark(block.mark);
    if (block.placed) {
      // gtk_text_view_remove should unparent the overlay child; force it if it didn't
      // (some node-gtk paths leave it parented → a stuck duplicate on re-add).
      try { (this.view as any).remove(block.widget); } catch { /* not a child */ }
      if (block.widget.getParent?.()) block.widget.unparent();
    }
  }
}
