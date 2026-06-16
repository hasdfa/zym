/*
 * DiffFold — collapse/expand the unchanged-context regions of a diff pane. Given
 * the fold regions `foldUnchanged` planned (in buffer-row indices) and the pane's
 * SourceView, it hides each fold's body with an `invisible` GtkTextTag, draws a
 * ▸/▾ chevron in the left gutter on the anchor line, and — while collapsed —
 * renders the `⋯ N unchanged lines` placeholder as an *inline block* (an overlay
 * widget with zero buffer footprint, via InlineBlockController), so the
 * placeholder is no longer editable/selectable buffer text. Regions start folded.
 *
 * It is its own fold mechanism, independent of SyntaxController's tree-sitter code
 * folding (which diff panes turn off): the diff buffer's structure is the diff,
 * not the code, so the only meaningful fold is "hide this run of context".
 *
 * Toggling routes through an `onActivate(index)` callback (chevron click or the
 * inline block's button), so the side-by-side view can fold both panes in lockstep
 * (their context rows align) and keep the scroll-sync valid.
 *
 * The gutter renderer is a node-gtk vfunc subclass, so it (and this whole object)
 * is only constructed at runtime, after the GTK main loop starts.
 */
import { Gtk, GtkSource, registerClass, type SourceBuffer, type SourceView } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import type { DiffFoldInfo } from '../../util/DiffModel.ts';
import type { InlineBlockController, InlineBlockHandle } from './InlineBlockController.ts';

const CHEVRON_FOLDED = '▸';
const CHEVRON_OPEN = '▾';

addStyles(`
  .diff-fold-band {
    color: ${theme.ui.textMuted ?? theme.ui.lineNumber ?? theme.ui.fg};
    background: alpha(${theme.ui.fg}, 0.06);
    padding: 0 8px;
    min-height: 0;
    border: none;
    box-shadow: none;
    border-radius: 4px;
  }
`);

interface Region extends DiffFoldInfo {
  index: number;
  folded: boolean;
  block: InlineBlockHandle | null;
}

class DiffFoldRenderer extends GtkSource.GutterRendererText {
  // Set right after construction; read on every draw. (line is 0-based.)
  fold!: DiffFold;

  queryData(_lines: any, line: number) {
    const region = this.fold?.regionAtAnchor(line);
    this.setMarkup(region ? (region.folded ? CHEVRON_FOLDED : CHEVRON_OPEN) : ' ', -1);
  }

  // Only anchor rows respond to a click.
  queryActivatable(iter: any, _area: any) {
    return Boolean(this.fold?.regionAtAnchor(iter.getLine()));
  }

  // @ts-expect-error - overriding the activate vfunc; the base class also exposes a
  // no-arg activate() action method, so the signatures don't unify.
  activate(iter: any, _area: any, _button: number, _state: any, _nPresses: number) {
    this.fold?.activateAnchor(iter.getLine());
  }
}
registerClass(DiffFoldRenderer);

export class DiffFold {
  private readonly view: SourceView;
  private readonly buffer: SourceBuffer;
  private readonly inlineBlocks: InlineBlockController;
  private readonly tag: any;
  private readonly regions: Region[];
  private readonly byAnchor = new Map<number, Region>();
  private readonly renderer: DiffFoldRenderer;
  private readonly onActivate: (index: number) => void;

  /**
   * @param onActivate called with a region's index when its chevron or placeholder
   *   is clicked; the owner decides what toggles (one pane, or both side-by-side).
   */
  constructor(
    view: SourceView,
    folds: readonly DiffFoldInfo[],
    inlineBlocks: InlineBlockController,
    onActivate: (index: number) => void,
  ) {
    this.view = view;
    this.buffer = (view as any).getBuffer();
    this.inlineBlocks = inlineBlocks;
    this.onActivate = onActivate;

    // A private invisible tag (one buffer per pane, so a fixed name is unique).
    this.tag = new Gtk.TextTag({ name: 'diff:fold-hidden', invisible: true } as any);
    (this.buffer as any).getTagTable().add(this.tag);

    this.regions = folds.map((f, index) => ({ ...f, index, folded: false, block: null }));
    for (const region of this.regions) {
      this.byAnchor.set(region.anchorRow, region);
      this.applyFold(region, true); // start collapsed
    }

    this.renderer = new DiffFoldRenderer();
    (this.renderer as any).fold = this;
    this.renderer.setXpad(4);
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);
  }

  /** The region whose chevron/placeholder anchors on buffer row `line`, if any. */
  regionAtAnchor(line: number): Region | undefined {
    return this.byAnchor.get(line);
  }

  /** A chevron was clicked on `line` — tell the owner which region's index it is. */
  activateAnchor(line: number): void {
    const region = this.byAnchor.get(line);
    if (region) this.onActivate(region.index);
  }

  /** Collapse/expand region `index` (called by the owner from `onActivate`). */
  toggle(index: number): void {
    const region = this.regions[index];
    if (region) {
      this.applyFold(region, !region.folded);
      this.keepAnchorVisible(region);
    }
  }

  /** Set region `index` to a specific folded state (for the owner's fold commands). */
  setFolded(index: number, folded: boolean): void {
    const region = this.regions[index];
    if (region) {
      this.applyFold(region, folded);
      this.keepAnchorVisible(region);
    }
  }

  /** After an explicit single-region toggle, keep the fold's anchor on screen
   *  (expanding it reveals lines that would otherwise push the cursor off-view). */
  private keepAnchorVisible(region: Region): void {
    const buffer = this.buffer as any;
    buffer.placeCursor(iterAtLine(buffer, region.anchorRow));
    (this.view as any).scrollToMark(buffer.getInsert(), 0.1, false, 0, 0);
  }

  /** Fold or unfold every region (vim `zM`/`zR`). */
  setAll(folded: boolean): void {
    for (const region of this.regions) this.applyFold(region, folded);
  }

  /** The region under this pane's cursor (its anchor row, or — when open — anywhere
   *  in its body), or -1. Drives the cursor-relative fold commands. */
  regionIndexAtCursor(): number {
    const row = this.cursorRow();
    return this.regions.findIndex(
      (r) => row === r.anchorRow || (!r.folded && row >= r.bodyStart && row <= r.bodyEnd),
    );
  }

  /** Open any folded region whose hidden body covers `row` (vim `foldopen`). */
  revealRow(row: number): void {
    for (const region of this.regions) {
      if (region.folded && row >= region.bodyStart && row <= region.bodyEnd) this.applyFold(region, false);
    }
  }

  /** Whether this pane's view currently holds keyboard focus. */
  viewHasFocus(): boolean {
    return Boolean((this.view as any).hasFocus?.());
  }

  private cursorRow(): number {
    const buffer = this.buffer as any;
    return iterAtMark(buffer, buffer.getInsert()).getLine();
  }

  private applyFold(region: Region, folded: boolean): void {
    if (region.folded === folded) return;
    const buffer = this.buffer as any;
    const start = iterAtLine(buffer, region.bodyStart);
    const end = iterAtLine(buffer, region.bodyEnd + 1); // include the body's last newline

    if (folded) {
      buffer.applyTag(this.tag, start, end);
      // Don't strand the cursor on a now-invisible body line — pull it up to the
      // still-visible anchor (GtkTextView's invisible-caret caveat).
      const cursor = this.cursorRow();
      if (cursor >= region.bodyStart && cursor <= region.bodyEnd) {
        buffer.placeCursor(iterAtLine(buffer, region.anchorRow));
      }
      // The placeholder is an overlay widget on the anchor line (no buffer text).
      region.block = this.inlineBlocks.add({
        line: region.anchorRow,
        placement: region.placement,
        widget: makeFoldWidget(region.count, () => this.onActivate(region.index)),
      });
    } else {
      buffer.removeTag(this.tag, start, end);
      region.block?.remove();
      region.block = null;
    }

    region.folded = folded;
    // Hiding/showing the body changes the layout; force a re-allocation so the view
    // reflows now (node-gtk's loop won't otherwise), then reposition the overlays.
    (this.view as any).queueResize?.();
    this.inlineBlocks.repositionAll();
    (this.view as any).queueDraw();
  }

  dispose(): void {
    for (const region of this.regions) region.block?.remove();
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}

/** The clickable `⋯ N unchanged lines` placeholder band (an overlay widget). */
function makeFoldWidget(count: number, onClick: () => void): InstanceType<typeof Gtk.Widget> {
  const button = new Gtk.Button({ label: `⋯ ${count} unchanged line${count === 1 ? '' : 's'}` });
  button.addCssClass('flat');
  button.addCssClass('diff-fold-band');
  button.on('clicked', onClick);
  return button;
}

/** getIterAtLine, defensively unwrapping node-gtk's [ok, iter] return shape. */
function iterAtLine(buffer: any, line: number): any {
  const res = buffer.getIterAtLine(line);
  return Array.isArray(res) ? res[1] : res;
}

/** getIterAtMark, defensively unwrapping node-gtk's [ok, iter] return shape. */
function iterAtMark(buffer: any, mark: any): any {
  const res = buffer.getIterAtMark(mark);
  return Array.isArray(res) ? res[1] : res;
}
