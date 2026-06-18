/*
 * IndentGuides — faint vertical lines marking each indentation level, drawn
 * in the leading whitespace. A transparent `Gtk.DrawingArea` stacked over the text
 * (like UnderlineOverlay), repainted on scroll and edits.
 *
 * Levels follow the *actual* indentation of each line (so guides line up with the
 * text), and a blank line borrows the level of the nearest non-blank line below
 * (then above) so guides run unbroken through blank lines inside a block.
 * Column→pixel uses the monospace char width measured from a visible content line.
 *
 * Toggle with `editor.indentGuides`. Drawing needs a realized, allocated view, so
 * the visual result needs interactive verification (not exercised headlessly).
 */
import { Gdk, Gtk, type SourceView } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { theme } from '../../theme/theme.ts';
import { quilx } from '../../quilx.ts';
import type { EditorModel } from './EditorModel.ts';

const LINE_WIDTH = 1;

function asIter(r: any): any {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

export class IndentGuides {
  readonly widget: InstanceType<typeof Gtk.DrawingArea>;

  private readonly view: SourceView;
  private readonly model: EditorModel;
  private enabled = true;
  private readonly rgba = new Gdk.RGBA();
  // Monospace metrics, measured lazily from a visible content line and cached
  // (constant for the editor's font; x0 is the column-0 buffer x).
  private charWidth = 0;
  private x0 = 0;

  constructor(view: SourceView, model: EditorModel) {
    this.view = view;
    this.model = model;
    this.rgba.parse(theme.ui.border);

    this.widget = new Gtk.DrawingArea();
    this.widget.setCanTarget(false);
    this.widget.setDrawFunc((_area: unknown, cr: any) => this.draw(cr));

    const redraw = () => this.widget.queueDraw();
    (view as any).getVadjustment()?.on('value-changed', redraw);
    (view as any).getHadjustment()?.on('value-changed', redraw);
    (view.getBuffer() as any).on('changed', redraw); // indentation may have changed
    quilx.config.observe('editor.indentGuides', (v) => {
      this.enabled = v !== false;
      redraw();
    });
  }

  private draw(cr: any): void {
    if (!this.enabled || !this.view.getRealized()) return;
    const view = this.view as any;
    const rect = view.getVisibleRect();
    if (!rect || !rect.height) return;

    const last = this.model.getLastBufferRow();
    const lineAtY = (y: number): number => asIter(view.getLineAtY(y)).getLine();
    const top = Math.max(0, lineAtY(rect.y));
    const bottom = Math.min(last, lineAtY(rect.y + rect.height));
    if (!this.ensureMetrics(top, bottom)) return;

    const tabLength = this.model.getTabLength();
    const stride = tabLength * this.charWidth;
    const [wx0] = view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, Math.round(this.x0), 0);

    cr.setLineWidth(LINE_WIDTH);
    cr.setSourceRgba(this.rgba.red, this.rgba.green, this.rgba.blue, this.rgba.alpha);
    for (let row = top; row <= bottom; row++) {
      const level = this.guideLevel(row, last);
      if (level <= 0) continue;
      const cell = view.getIterLocation(this.model.iterAtPoint(new Point(row, 0)));
      const [, wy] = view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, 0, cell.y);
      for (let k = 0; k < level; k++) {
        const x = Math.round(wx0 + k * stride) + 0.5; // +0.5 → crisp 1px line
        cr.moveTo(x, wy);
        cr.lineTo(x, wy + cell.height);
      }
    }
    cr.stroke();
  }

  /** The indent level whose guides this row should show. */
  private guideLevel(row: number, last: number): number {
    if (!this.model.isBufferRowBlank(row)) return Math.floor(this.model.indentationForBufferRow(row));
    // Blank line: continue the guides of the nearest non-blank line below, else above.
    for (let r = row + 1; r <= last; r++) {
      if (!this.model.isBufferRowBlank(r)) return Math.floor(this.model.indentationForBufferRow(r));
    }
    for (let r = row - 1; r >= 0; r--) {
      if (!this.model.isBufferRowBlank(r)) return Math.floor(this.model.indentationForBufferRow(r));
    }
    return 0;
  }

  /** Measure the monospace char width + column-0 x from a visible content line. */
  private ensureMetrics(top: number, bottom: number): boolean {
    if (this.charWidth > 0) return true;
    const view = this.view as any;
    for (let row = top; row <= bottom; row++) {
      if (this.model.lineLength(row) < 2) continue;
      const a = view.getIterLocation(this.model.iterAtPoint(new Point(row, 0)));
      const b = view.getIterLocation(this.model.iterAtPoint(new Point(row, 1)));
      if (b.x > a.x) {
        this.x0 = a.x;
        this.charWidth = b.x - a.x;
        return true;
      }
    }
    return false; // nothing measurable on screen yet
  }
}
