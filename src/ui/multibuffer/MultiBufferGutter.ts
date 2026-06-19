/*
 * MultiBufferGutter — a left-gutter renderer drawing each row's *source* line number in a
 * multibuffer (project search). A multibuffer view row doesn't equal a source line: header /
 * gap / blank rows are synthesized, and each excerpt shows a slice of a different file. So the
 * renderer asks the LIVE `ViewProjection` for the source line behind each view row
 * (`sourceRowAtViewRow`) — a real source row renders `sourceRow + 1`, a block / folded row
 * renders blank (the column keeps its width). Re-segmentation swaps the projection, so it's
 * read through a getter rather than captured.
 *
 * Mirrors `DiffLineNumberGutter`: a `GtkSource.GutterRendererText` subclass instantiated only
 * at runtime (the node-gtk vfunc constraint), width *primed* up front so a number measured on a
 * short line isn't cropped.
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import type { ViewProjection } from '../TextEditor/ViewProjection.ts';

const COLOR = theme.ui.editor.lineNumber;

/** The gutter label for one view row: the 1-based SOURCE line number behind it, right-aligned
 *  to `width`; all-blank (width spaces) for a header / gap / blank / folded row. Pure — the
 *  unit-tested core of the renderer. */
export function lineNumberLabel(projection: ViewProjection, viewRow: number, width: number): string {
  const src = projection.sourceRowAtViewRow(viewRow);
  return (src ? String(src.sourceRow + 1) : '').padStart(width);
}

class MultiBufferLineRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw.
  getProjection!: () => ViewProjection;
  width = 1;

  queryData(_lines: any, line: number) {
    const label = lineNumberLabel(this.getProjection(), line, this.width);
    this.setMarkup(`<span foreground="${COLOR}">${label || ' '}</span>`, -1);
  }
}
registerClass(MultiBufferLineRenderer);

export class MultiBufferGutter {
  private readonly view: SourceView;
  private readonly renderer: MultiBufferLineRenderer;

  /** `maxLineNumber` is the widest 1-based source line that can show (sizes the column; an
   *  edit can grow a source past it, but crossing a digit boundary is rare and only widens
   *  padding, never the rendered number, which is read live). */
  constructor(view: SourceView, getProjection: () => ViewProjection, maxLineNumber: number) {
    this.view = view;
    this.renderer = new MultiBufferLineRenderer();
    (this.renderer as any).getProjection = getProjection;
    (this.renderer as any).width = String(Math.max(1, maxLineNumber)).length;
    this.renderer.setXpad(4);
    // Bottom-align the number within its cell. An excerpt's first row carries a header-widget
    // band above it (`pixels-above-lines`), so a top-aligned number would float up in that band
    // beside the filepath widget; aligning to the cell bottom keeps it on the text line. A
    // no-op for ordinary rows (cell height == text height).
    (this.renderer as any).yalign = 1;
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);

    // Reserve width for the widest number up front (a number measured on a short line crops).
    this.renderer.setText('0'.repeat((this.renderer as any).width), -1);
    this.renderer.queueResize();
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}
