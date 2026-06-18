/*
 * paintRegions — tiny interval-set helpers for the SyntaxController's *persistent*
 * highlight cache. As the view scrolls we accumulate the line ranges that have been
 * fully token-highlighted (never clearing them — the text didn't change, so the tags
 * stay valid), and only paint the parts of a newly-visible range that aren't covered
 * yet. Ranges are inclusive `[fromLine, toLine]`, kept sorted and non-overlapping.
 */

export type LineRange = [number, number];

/** The sub-ranges of `[a, b]` not covered by the sorted, non-overlapping `ranges`. */
export function rangeGaps(ranges: ReadonlyArray<LineRange>, a: number, b: number): LineRange[] {
  const gaps: LineRange[] = [];
  let cur = a;
  for (const [lo, hi] of ranges) {
    if (hi < cur) continue; // entirely before the cursor
    if (lo > b) break; // past the end of the query
    if (lo > cur) gaps.push([cur, lo - 1]);
    cur = hi + 1;
    if (cur > b) return gaps;
  }
  if (cur <= b) gaps.push([cur, b]);
  return gaps;
}

/** Insert `[a, b]` into the sorted, non-overlapping `ranges`, merging overlapping or
 *  adjacent (touching) ranges. Returns a new array. */
export function mergeRange(ranges: ReadonlyArray<LineRange>, a: number, b: number): LineRange[] {
  const out: LineRange[] = [];
  let lo = a;
  let hi = b;
  let placed = false;
  for (const [rlo, rhi] of ranges) {
    if (rhi + 1 < lo) {
      out.push([rlo, rhi]); // entirely before the new range, no touch
    } else if (rlo > hi + 1) {
      if (!placed) {
        out.push([lo, hi]);
        placed = true;
      }
      out.push([rlo, rhi]); // entirely after, no touch
    } else {
      lo = Math.min(lo, rlo); // overlap or adjacency → absorb
      hi = Math.max(hi, rhi);
    }
  }
  if (!placed) out.push([lo, hi]);
  return out;
}
