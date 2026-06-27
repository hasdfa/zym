/*
 * StickyHeaders — the multi-file diff's per-file headers, pinned to the top of the viewport
 * (VSCode-style sticky scroll) while their file scrolls under them (docs/text-editor/diff.md).
 *
 * It is a thin reconcile + focus layer over the `BlockDecorations` primitive: each header is an
 * `on`-placed, `sticky` block decoration — a real widget COVERING its (empty, read-only) header line
 * (so the caret rests on it) and a child of the TEXT WINDOW (so it scrolls natively: smooth on a
 * touchpad, never swallows scroll, clips to the viewport, and stays click-to-jump), with its overlay
 * Y clamped to the scroll top so it pins. The
 * primitive owns the placement, slot pooling, band reservation, timing, and the scroll clamp; this
 * class only reconciles the set (add / move / swap-on-content-change / remove, by id) and toggles the
 * `.focused` class on the header whose row the caret sits on.
 *
 * One widget per file. The primitive's sticky push-up (each band clamped above the next sticky band)
 * keeps exactly one header pinned — an earlier file's header slides up and out as the next reaches
 * the top. `DiffView` drives this via `setHeaders`.
 */
import type { Gtk } from '../../gi.ts';
import type { BlockDecorations, BlockDecorationHandle } from './BlockDecorations.ts';

const FOCUSED_CLASS = 'mb-header-focused';

/** One file's sticky header. `id` is stable per file (its path); `key` is the content identity
 *  (rebuild the widget only when it changes); `viewRow` is the EMPTY navigable header block row the
 *  widget floats above. */
export interface StickyHeaderSpec {
  id: string;
  key: string;
  viewRow: number;
  build: () => InstanceType<typeof Gtk.Widget>;
  /** Sever anything node-gtk roots on the built widget (the click controller) when it's replaced or
   *  removed — paired with `build` (see docs/lifecycle-and-disposal.md rule 9). */
  dispose?: () => void;
}

interface Entry {
  handle: BlockDecorationHandle;
  widget: any;
  key: string;
  viewRow: number;
  dispose?: () => void;
}

export class StickyHeaders {
  private readonly blocks: BlockDecorations;
  private readonly entries = new Map<string, Entry>();
  private focusedRow: number | null = null;

  constructor(blocks: BlockDecorations) {
    this.blocks = blocks;
  }

  /** Declare the header set; reconciles in place (reuse by `id`, rebuild a widget only when its
   *  `key` changed, remove gone). Call on each structural change (re-diff / collapse) — header rows
   *  shift, so the anchor line is re-set from the fresh `viewRow`. */
  setHeaders(specs: StickyHeaderSpec[]): void {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.id);
      const prev = this.entries.get(spec.id);
      if (prev) {
        if (prev.key !== spec.key) {
          prev.dispose?.(); // old widget is about to be replaced — sever its rooted controllers
          prev.widget = spec.build();
          prev.handle.update({ line: spec.viewRow, widget: prev.widget });
          prev.key = spec.key;
          prev.dispose = spec.dispose;
        } else {
          prev.handle.update({ line: spec.viewRow }); // unchanged content — keep the widget, re-anchor
        }
        prev.viewRow = spec.viewRow;
      } else {
        const widget = spec.build();
        const handle = this.blocks.add({ line: spec.viewRow, widget, placement: 'on', sticky: true });
        this.entries.set(spec.id, { handle, widget, key: spec.key, viewRow: spec.viewRow, dispose: spec.dispose });
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.dispose?.();
        entry.handle.remove();
        this.entries.delete(id);
      }
    }
    this.applyFocus();
  }

  /** Highlight the header whose anchor row the caret sits on (or none) — so the header reads as
   *  focused even though the caret rests on the empty line beneath the floating widget. */
  setFocusedRow(row: number | null): void {
    if (this.focusedRow === row) return;
    this.focusedRow = row;
    this.applyFocus();
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.dispose?.(); // sever the widget's controllers before dropping it
      entry.handle.remove();
    }
    this.entries.clear();
  }

  /** Idempotent teardown (the editor owns the underlying `BlockDecorations`; this just drops our
   *  handles + severs each header widget's controllers). */
  dispose(): void {
    this.clear();
  }

  private applyFocus(): void {
    for (const entry of this.entries.values()) {
      const on = this.focusedRow != null && entry.viewRow === this.focusedRow;
      if (on) entry.widget.addCssClass(FOCUSED_CLASS);
      else entry.widget.removeCssClass(FOCUSED_CLASS);
    }
  }
}
