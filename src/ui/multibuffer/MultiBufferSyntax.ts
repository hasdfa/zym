/*
 * MultiBufferSyntax — the multibuffer's syntax *projector*. It paints the one
 * concatenated GtkSourceView buffer by pulling each excerpt's highlight captures from ITS
 * source's shared `DocumentSyntax` (the Phase-0 per-Document parse, in source-model coords)
 * and translating them onto the excerpt's view rows. So every file is highlighted by its
 * OWN grammar — the multi-language correctness a single concatenated parse can't give
 * (and the wart `DiffView` has, parsing interleaved +/- lines as one language).
 *
 * This is the keystone Phase 0 unlocked: one parse per source Document serves a full-file
 * editor AND a 5-line excerpt of it here, because captures are model coords and each
 * surface translates them. Phase 1a paints once (read-only snapshot); live re-projection on
 * source edits arrives with editing (Phase 2).
 */
import { Gtk, Pango, type SourceBuffer, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { HighlightTags } from '../../syntax/highlightTags.ts';
import type { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import type { MultiBufferProjection, RowEntry } from './MultiBufferModel.ts';

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export class MultiBufferSyntax {
  private readonly buffer: SourceBuffer;
  private readonly highlight: HighlightTags;
  /** Bold + banded, non-editable filename header rows. */
  private readonly headerTag: any;
  /** Muted `⋯` gap rows between non-adjacent segments. */
  private readonly gapTag: any;
  // Per-segment cache of the (UTF-16→codepoint) need, keyed by the source — the view row's
  // text is a verbatim copy of the source row, so we convert against the VIEW buffer.
  private readonly lineTextCache = new Map<number, string>();

  constructor(_view: SourceView, buffer: SourceBuffer) {
    this.buffer = buffer;
    const table = (buffer as any).getTagTable();
    // Build highlight tags FIRST (priority follows creation order; header/gap layer on top).
    this.highlight = new HighlightTags(table);
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

  /** Re-apply token colors from the theme (system light/dark change). */
  restyle(): void {
    this.highlight.restyle();
  }

  /**
   * Paint the whole projection: clear our tags, then for each segment pull its source's
   * captures (source-model coords) and paint them at the segment's view rows; finally style
   * the header + gap rows. `sources` maps each segment's `sourceKey` to its `DocumentSyntax`
   * (the source must already be parsed — the view ensures that before calling).
   */
  paint(projection: MultiBufferProjection, sources: Map<string, DocumentSyntax>): void {
    const buffer = this.buffer as any;
    this.lineTextCache.clear();
    this.highlight.clear(buffer, buffer.getStartIter(), buffer.getEndIter());
    for (const entry of projection.entries) {
      if (entry.kind === 'header') {
        this.applyRow(this.headerTag, entry);
      } else if (entry.kind === 'gap') {
        this.applyRow(this.gapTag, entry);
      } else if (entry.kind === 'segment') {
        this.paintSegment(entry, sources.get(entry.segment.sourceKey));
      }
    }
  }

  /** Paint one segment's view rows from its source's captures. */
  private paintSegment(entry: Extract<RowEntry, { kind: 'segment' }>, source: DocumentSyntax | undefined): void {
    if (!source || !source.hasTree) return;
    const { segment, viewStart } = entry;
    const captures = source.captures(segment.startRow, segment.endRow);
    // Translate a source (row, col) capture position onto this segment's view rows. The view
    // row's text is a verbatim copy of the source row, so a UTF-16→codepoint conversion done
    // against the VIEW buffer line yields the same column the source would.
    const iterAt = (sourceRow: number, sourceCol: number): any => {
      const viewRow = viewStart + (sourceRow - segment.startRow);
      // Out of the segment's painted rows (a capture spilling past endRow) → clamp to its end.
      if (viewRow < viewStart || viewRow >= viewStart + entry.viewCount) {
        return asIter((this.buffer as any).getIterAtLine(Math.min(Math.max(viewRow, viewStart), viewStart + entry.viewCount - 1)));
      }
      const col = source.hasAstral ? this.toCodepointColumn(viewRow, sourceCol) : sourceCol;
      return asIter((this.buffer as any).getIterAtLineOffset(viewRow, col));
    };
    this.highlight.paint(this.buffer, captures, iterAt);
  }

  /** Apply `tag` across a single-row entry's view line (incl. its trailing newline, so the
   *  paragraph background spans the full row). */
  private applyRow(tag: any, entry: RowEntry): void {
    const buffer = this.buffer as any;
    const start = asIter(buffer.getIterAtLine(entry.viewStart));
    const end = asIter(buffer.getIterAtLine(entry.viewStart + entry.viewCount));
    // getIterAtLine past the last line returns the end iter; covers the trailing newline.
    buffer.applyTag(tag, start, end.getLine() === entry.viewStart ? this.endOfLine(entry.viewStart) : end);
  }

  private endOfLine(line: number): any {
    const iter = asIter((this.buffer as any).getIterAtLine(line));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }

  /** UTF-16 column on the VIEW buffer's `line` → codepoint column (surrogate pairs count as
   *  one), for astral source text copied verbatim into the view. */
  private toCodepointColumn(line: number, utf16Col: number): number {
    if (utf16Col <= 0) return utf16Col;
    let text = this.lineTextCache.get(line);
    if (text === undefined) {
      const start = asIter((this.buffer as any).getIterAtLine(line));
      const end = start.copy();
      if (!end.endsLine()) end.forwardToLineEnd();
      text = (this.buffer as any).getText(start, end, true) as string;
      this.lineTextCache.set(line, text);
    }
    let cp = 0;
    for (let i = 0; i < utf16Col && i < text.length; cp++) {
      const code = text.charCodeAt(i);
      i += code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
    }
    return cp;
  }
}
