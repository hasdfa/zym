/*
 * MultiBufferModel — the pure substrate for the multibuffer (continuous multi-file
 * diff/search surface; see tasks/code-editing/multibuffer.md). It models the view as a
 * list of **excerpts**, each a filename header plus an ordered list of **segments**, and
 * builds (a) the concatenated projection TEXT shown in the one GtkSourceView and (b) a
 * **coordinate map** translating view row ↔ (segment, source row).
 *
 * Phase 1a exercises the easy subset — all segments `real`, one source each, no phantoms,
 * no old/new — but the shape is diff-capable from day one: Phase 1b adds `phantom` removed
 * rows and old/new sources, Phase 2 flips new-side segments `editable` + writes through.
 *
 * Pure + dependency-free (no GTK, no Document) so the coordinate math is unit-tested in
 * isolation — the place a stitched-coordinate bug must surface, per the plan. The view
 * layer resolves each segment's source rows to text via the `resolveLines` callback.
 */

/** A contiguous slice of one source, projected into the multibuffer. */
export interface Segment {
  /** Stable key for the source (Phase 1a: the file path). The view maps it to a
   *  `Document` + its shared `DocumentSyntax`. */
  sourceKey: string;
  /** Source model rows `[startRow, endRow]` (inclusive) this segment projects. */
  startRow: number;
  endRow: number;
  /** Phase 1a: always false (read-only). Phase 2 flips new-side segments editable. */
  editable: boolean;
  /** `real` = mapped to live source text; `phantom` = read-only synthesized (Phase 1b
   *  removed rows). Phase 1a is all `real`. */
  kind: 'real' | 'phantom';
}

/** One excerpt: a header (filename) + ordered segments (Phase 1a: one source each, gaps
 *  between non-adjacent segments of the same file). */
export interface Excerpt {
  /** The header label shown as a non-editable block row (e.g. the file path). */
  header: string;
  segments: Segment[];
}

/** A contiguous run of view rows of one kind. The map is a sorted list of these; a binary
 *  search over `viewStart` resolves a view row (enough for hundreds of excerpts — reach for
 *  a sum-tree only at thousands). */
export type RowEntry =
  | { kind: 'header'; viewStart: number; viewCount: number; excerptIndex: number }
  | { kind: 'gap'; viewStart: number; viewCount: number; excerptIndex: number }
  | { kind: 'blank'; viewStart: number; viewCount: number }
  | {
      kind: 'segment';
      viewStart: number;
      viewCount: number;
      excerptIndex: number;
      segmentIndex: number;
      segment: Segment;
    };

/** A position inside a source resolved from a view row. */
export interface SourceLocation {
  sourceKey: string;
  sourceRow: number;
  segment: Segment;
  excerptIndex: number;
  segmentIndex: number;
}

/** The label shown on a gap row between two non-adjacent segments of one file. */
export const GAP_LABEL = '⋯';

export class MultiBufferProjection {
  readonly text: string;
  readonly entries: RowEntry[];
  /** Total view rows (== entries' summed viewCount == text line count). */
  readonly rowCount: number;

  private constructor(text: string, entries: RowEntry[], rowCount: number) {
    this.text = text;
    this.entries = entries;
    this.rowCount = rowCount;
  }

  /**
   * Build the projection text + coordinate map from `excerpts`. `resolveLines(segment)`
   * returns the source text rows the segment covers (`endRow - startRow + 1` of them, no
   * trailing newline). Layout per excerpt: a header row, each segment's rows, a `⋯` gap row
   * between non-adjacent segments, and a blank separator row between excerpts.
   */
  static build(excerpts: Excerpt[], resolveLines: (segment: Segment) => string[]): MultiBufferProjection {
    const lines: string[] = [];
    const entries: RowEntry[] = [];
    const push = (entry: RowEntry, text: string[]): void => {
      entries.push(entry);
      for (const line of text) lines.push(line);
    };

    excerpts.forEach((excerpt, excerptIndex) => {
      if (excerptIndex > 0) push({ kind: 'blank', viewStart: lines.length, viewCount: 1 }, ['']);
      push({ kind: 'header', viewStart: lines.length, viewCount: 1, excerptIndex }, [excerpt.header]);
      excerpt.segments.forEach((segment, segmentIndex) => {
        // A `⋯` gap between this segment and the previous one of the same excerpt (the
        // source rows between them are elided).
        if (segmentIndex > 0) push({ kind: 'gap', viewStart: lines.length, viewCount: 1, excerptIndex }, [GAP_LABEL]);
        const body = resolveLines(segment);
        push(
          { kind: 'segment', viewStart: lines.length, viewCount: body.length, excerptIndex, segmentIndex, segment },
          body,
        );
      });
    });

    // Join with newlines + a trailing newline, so the buffer's last line is empty (every
    // content row is terminated) — matches how GtkSource buffers carry a trailing line.
    const text = lines.length ? lines.join('\n') + '\n' : '';
    return new MultiBufferProjection(text, entries, lines.length);
  }

  /** The RowEntry containing `viewRow` (binary search), or null if out of range. */
  entryAt(viewRow: number): RowEntry | null {
    if (viewRow < 0 || viewRow >= this.rowCount) return null;
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid];
      if (viewRow < e.viewStart) hi = mid - 1;
      else if (viewRow >= e.viewStart + e.viewCount) lo = mid + 1;
      else return e;
    }
    return null;
  }

  /** Resolve a view row to its source location, or null for a header / gap / blank row. */
  sourceAt(viewRow: number): SourceLocation | null {
    const e = this.entryAt(viewRow);
    if (!e || e.kind !== 'segment') return null;
    return {
      sourceKey: e.segment.sourceKey,
      sourceRow: e.segment.startRow + (viewRow - e.viewStart),
      segment: e.segment,
      excerptIndex: e.excerptIndex,
      segmentIndex: e.segmentIndex,
    };
  }

  /** Whether `viewRow` is editable (a `real` + `editable` segment row). Phase 1a: always
   *  false; the seam Phase 2 uses to gate write-through + clamp edits at boundaries. */
  isEditable(viewRow: number): boolean {
    const e = this.entryAt(viewRow);
    return !!e && e.kind === 'segment' && e.segment.editable && e.segment.kind === 'real';
  }

  /** The view row showing `(sourceKey, sourceRow)`, or null if that row isn't projected.
   *  When several segments project the same source row (shouldn't happen in 1a) the first
   *  wins. */
  viewRowForSource(sourceKey: string, sourceRow: number): number | null {
    for (const e of this.entries) {
      if (e.kind !== 'segment' || e.segment.sourceKey !== sourceKey) continue;
      if (sourceRow >= e.segment.startRow && sourceRow <= e.segment.endRow) {
        return e.viewStart + (sourceRow - e.segment.startRow);
      }
    }
    return null;
  }

  /** Segment entries that overlap the view row range `[fromRow, toRow]` (inclusive) — what
   *  the syntax projector iterates to paint the visible region. */
  segmentsInViewRange(fromRow: number, toRow: number): Array<Extract<RowEntry, { kind: 'segment' }>> {
    const out: Array<Extract<RowEntry, { kind: 'segment' }>> = [];
    for (const e of this.entries) {
      if (e.kind !== 'segment') continue;
      if (e.viewStart > toRow) break;
      if (e.viewStart + e.viewCount - 1 < fromRow) continue;
      out.push(e);
    }
    return out;
  }
}
