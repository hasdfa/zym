/*
 * DiffLineNumberGutter — a left-gutter renderer drawing *file* line numbers in a
 * diff pane (not the synthesized buffer's row numbers). One renderer = one column;
 * a unified pane uses two (old + new file rows), a side-by-side pane one per side.
 * Labels are precomputed per MODEL row (the unfolded diff buffer); a queried view
 * line is translated back through the folds.
 *
 * The width is *primed* (like SyntaxController's line numbers): GtkSourceGutter-
 * RendererText sizes from the currently-set text, so without priming a column
 * measured on a short/blank line crops the wider numbers. The whole left gutter
 * gets a neutral background so the added/removed line tints read only in the text.
 *
 * Mirrors DiffGutter — a `GtkSource.GutterRendererText` subclass, instantiated only
 * at runtime (the node-gtk vfunc constraint).
 */
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';

const COLOR = theme.ui.editor.lineNumber;

/** Split a `#rrggbb(aa)` color into a Pango `background` color + a `background_alpha` percentage
 *  (Pango markup's `background` ignores alpha; the alpha rides in `background_alpha`). */
function pangoBackground(color: string): { rgb: string; alphaPct: number } {
  const hex = color.replace('#', '');
  const alpha = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { rgb: `#${hex.slice(0, 6)}`, alphaPct: Math.max(1, Math.round(alpha * 100)) };
}

class DiffLineNumberRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. (line is 0-based.)
  labels!: string[];
  viewToModel!: (line: number) => number;
  // Per-row cell background (`#rrggbbaa`) or null — added/removed rows tint their side's column.
  backgrounds: (string | null)[] | null = null;

  queryData(_lines: any, line: number) {
    const model = this.viewToModel ? this.viewToModel(line) : line;
    const label = this.labels?.[model] ?? '';
    const bg = this.backgrounds?.[model] ?? null;
    let attrs = `foreground="${COLOR}"`;
    if (bg) {
      const { rgb, alphaPct } = pangoBackground(bg);
      // The space-padded label spans the column width, so the background reads as a full band.
      attrs = `background="${rgb}" background_alpha="${alphaPct}%" ${attrs}`;
    }
    this.setMarkup(`<span ${attrs}>${label || ' '}</span>`, -1);
  }
}
registerClass(DiffLineNumberRenderer);

export class DiffLineNumberGutter {
  private readonly view: SourceView;
  private readonly renderer: DiffLineNumberRenderer;

  /** `position` orders the gutter columns L→R (chevron 0, line numbers, then +/−). `backgrounds`
   *  (optional, indexed like `labels`) tints added/removed rows' cells. */
  constructor(
    view: SourceView,
    labels: string[],
    viewToModel: ((line: number) => number) | undefined,
    position: number,
    backgrounds?: (string | null)[],
  ) {
    this.view = view;
    this.renderer = new DiffLineNumberRenderer();
    this.renderer .labels = labels;
    this.renderer.viewToModel = viewToModel ?? ((line: number) => line);
    this.renderer.backgrounds = backgrounds ?? null;
    this.renderer.setXpad(4);
    (this.view.getGutter(Gtk.TextWindowType.LEFT) as any).insert(this.renderer, position);

    this.primeWidth(labels);
  }

  /** Swap the per-row labels + cell backgrounds (after a re-diff re-flows the rows) and repaint. */
  setData(labels: string[], backgrounds?: (string | null)[]): void {
    (this.renderer as any).labels = labels;
    this.renderer.backgrounds = backgrounds ?? null;
    this.primeWidth(labels);
    (this.renderer as any).queueDraw?.();
  }

  /** Reserve width for the widest label (a number measured on a short line would crop). */
  private primeWidth(labels: string[]): void {
    const width = labels.reduce((max, label) => Math.max(max, label.length), 1);
    this.renderer.setText('0'.repeat(width), -1);
    this.renderer.queueResize();
  }

  dispose(): void {
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
  }
}

// Right-align `n+1` (or blank) in a column sized to the widest number.
function column(rows: readonly (number | null)[]): string[] {
  let max = 0;
  for (const row of rows) if (row != null) max = Math.max(max, row + 1);
  const width = String(Math.max(1, max)).length;
  return rows.map((row) => (row != null ? String(row + 1).padStart(width) : ' '.repeat(width)));
}

/** Old-file line numbers, one per unified DiffLine (blank on added lines). */
export function oldLineLabels(lines: readonly { oldRow: number | null }[]): string[] {
  return column(lines.map((l) => l.oldRow));
}
/** New-file line numbers, one per unified DiffLine (blank on removed lines). */
export function newLineLabels(lines: readonly { newRow: number | null }[]): string[] {
  return column(lines.map((l) => l.newRow));
}
/** This side's file line numbers, one per side-by-side row (blank on fillers). */
export function sideLineLabels(lines: readonly { row: number | null }[]): string[] {
  return column(lines.map((l) => l.row));
}
