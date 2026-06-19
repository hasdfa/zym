/*
 * MultiBufferModel — the multibuffer's excerpt LAYOUT (tasks/code-editing/multibuffer.md). It
 * models a multi-file surface as a list of **excerpts** (a filename header + ordered source
 * **segments**) and flattens them into the ordered `Item[]` that `ViewProjection` (the unified
 * coordinate substrate) materializes: a blank separator between excerpts, a header row, each
 * segment's rows, and a `⋯` gap row between non-adjacent segments of one file.
 *
 * The coordinate math (view ↔ source, painting runs, block-row styling) now lives in
 * `ViewProjection` — this is just the multibuffer-specific item layout on top of it; the
 * `MultiBufferProjection` class that used to own the coordinate map was retired when the
 * single-file editor and the multibuffer were unified onto one substrate (Phase 3a).
 */
import type { Item, Segment as ProjectionSegment } from '../TextEditor/ViewProjection.ts';

/** A contiguous slice of one source, projected into the multibuffer. Re-exported from the
 *  unified substrate so excerpt builders keep a stable import here. */
export type Segment = ProjectionSegment;

/** One excerpt: a header (filename) + ordered segments (one source each; gaps between
 *  non-adjacent segments of the same file). */
export interface Excerpt {
  /** The header label shown as a non-editable block row (e.g. the file path). */
  header: string;
  segments: Segment[];
}

/** The label shown on a gap row between two non-adjacent segments of one file. */
export const GAP_LABEL = '⋯';

/**
 * Flatten `excerpts` into the ordered projection items `ViewProjection.build` consumes.
 * Layout per excerpt: a blank separator before all but the first, a header row, then each
 * segment's rows with a `⋯` gap row between non-adjacent segments of the same excerpt.
 */
export function excerptsToItems(excerpts: Excerpt[]): Item[] {
  const items: Item[] = [];
  excerpts.forEach((excerpt, excerptIndex) => {
    if (excerptIndex > 0) items.push({ type: 'block', block: { kind: 'blank', text: '' } });
    items.push({ type: 'block', block: { kind: 'header', text: excerpt.header } });
    excerpt.segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) items.push({ type: 'block', block: { kind: 'gap', text: GAP_LABEL } });
      items.push({ type: 'segment', segment });
    });
  });
  return items;
}
