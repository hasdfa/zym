/*
 * ExcerptSyntaxProjection — the multibuffer's `SyntaxProjection`. It tells the per-view
 * painter (`SyntaxController`), for a visible view-row range, which source `DocumentSyntax`
 * to query and where each source row lands, and styles the filename-header / `⋯` gap rows.
 * The painter owns the buffer + its `HighlightTags` and does the actual painting, so there's
 * ONE highlighter on the buffer (no tag collision) and every excerpt is highlighted by its
 * own grammar — the keystone Phase 0 unlocked (one parse per Document, many projections).
 */
import { Gtk, Pango } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import type { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import type { SyntaxProjection, SyntaxSlice } from '../../syntax/SyntaxProjection.ts';
import type { MultiBufferProjection } from './MultiBufferModel.ts';

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

export class ExcerptSyntaxProjection implements SyntaxProjection {
  private headerTag: any = null;
  private gapTag: any = null;
  private readonly projection: MultiBufferProjection;
  private readonly sources: Map<string, DocumentSyntax>;

  // Note: explicit field assignment (not constructor parameter properties) — Node runs .ts
  // in strip-only mode, which rejects parameter properties at runtime.
  constructor(projection: MultiBufferProjection, sources: Map<string, DocumentSyntax>) {
    this.projection = projection;
    this.sources = sources;
  }

  hasContent(): boolean {
    for (const source of this.sources.values()) if (source.hasTree) return true;
    return false;
  }

  paintSlices(viewFrom: number, viewTo: number): SyntaxSlice[] {
    const slices: SyntaxSlice[] = [];
    for (const entry of this.projection.segmentsInViewRange(viewFrom, viewTo)) {
      const syntax = this.sources.get(entry.segment.sourceKey);
      if (!syntax) continue;
      const visTop = Math.max(viewFrom, entry.viewStart);
      const visBot = Math.min(viewTo, entry.viewStart + entry.viewCount - 1);
      slices.push({
        syntax,
        fromRow: entry.segment.startRow + (visTop - entry.viewStart),
        toRow: entry.segment.startRow + (visBot - entry.viewStart),
        sourceStart: entry.segment.startRow,
        viewStart: entry.viewStart,
      });
    }
    return slices;
  }

  onDidReparse(callback: () => void): () => void {
    const unsubs = [...new Set(this.sources.values())].map((source) => source.onDidReparse(callback));
    return () => { for (const unsub of unsubs) unsub(); };
  }

  /** Style the header / gap rows (created lazily on `buffer`'s tag table — distinct names
   *  from the painter's highlight tags, so no collision). */
  decorate(buffer: any): void {
    if (!this.headerTag) this.buildTags(buffer);
    for (const entry of this.projection.entries) {
      if (entry.kind === 'header') this.applyRow(buffer, this.headerTag, entry.viewStart, entry.viewCount);
      else if (entry.kind === 'gap') this.applyRow(buffer, this.gapTag, entry.viewStart, entry.viewCount);
    }
  }

  private buildTags(buffer: any): void {
    const table = buffer.getTagTable();
    const mk = (props: Record<string, unknown>) => { const t = new Gtk.TextTag(props); table.add(t); return t; };
    this.headerTag = mk({
      name: 'mb:header',
      editable: false,
      weight: Pango.Weight.BOLD,
      foreground: theme.ui.text.muted,
      paragraphBackground: theme.ui.surface.selected ?? theme.ui.surface.popover,
    });
    this.gapTag = mk({ name: 'mb:gap', editable: false, foreground: theme.ui.text.muted });
  }

  /** Apply `tag` across a single-row entry's view line, including its trailing newline so
   *  the paragraph background spans the full row. */
  private applyRow(buffer: any, tag: any, viewStart: number, viewCount: number): void {
    const start = asIter(buffer.getIterAtLine(viewStart));
    const endIter = asIter(buffer.getIterAtLine(viewStart + viewCount));
    const end = endIter.getLine() === viewStart ? this.endOfLine(buffer, viewStart) : endIter;
    buffer.applyTag(tag, start, end);
  }

  private endOfLine(buffer: any, line: number): any {
    const iter = asIter(buffer.getIterAtLine(line));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }
}
