/*
 * Range — an immutable span between two Points, `start` and `end`.
 *
 * A Range is always normalized so `start <= end` (in reading order); construct
 * it from either ordering and it sorts the endpoints for you. An *empty* range
 * has `start` equal to `end` and covers no characters (the position of a
 * collapsed cursor). A range is the unit operators act on — the text a motion or
 * text-object selects — so its containment/intersection predicates are the
 * workhorses of the vim layer.
 *
 * The API mirrors the well-known text-buffer `Range` so ported vim-mode-plus
 * code keeps its exact semantics.
 */
import { Point, type PointLike } from './Point.ts';

/** Anything coercible to a Range: a Range, `[start, end]`, or `{ start, end }`. */
export type RangeLike =
  | Range
  | [PointLike, PointLike]
  | { start: PointLike; end: PointLike };

export class Range {
  /** Coerce `object` to a Range. With `copy`, always returns a fresh instance. */
  static fromObject(object: RangeLike, copy = false): Range {
    if (Array.isArray(object)) return new Range(object[0], object[1]);
    if (object instanceof Range) return copy ? object.copy() : object;
    return new Range(object.start, object.end);
  }

  /** A range from `startPoint` extended by a row/column delta. */
  static fromPointWithDelta(startPoint: PointLike, rowDelta: number, columnDelta: number): Range {
    const start = Point.fromObject(startPoint);
    const end = new Point(start.row + rowDelta, start.column + columnDelta);
    return new Range(start, end);
  }

  /** A range from `startPoint` whose end is `start.traverse(extent)`. */
  static fromPointWithTraversalExtent(startPoint: PointLike, extent: PointLike): Range {
    const start = Point.fromObject(startPoint);
    return new Range(start, start.traverse(extent));
  }

  start: Point;
  end: Point;

  constructor(pointA: PointLike = new Point(), pointB: PointLike = pointA) {
    const a = Point.fromObject(pointA, true);
    const b = Point.fromObject(pointB, true);
    if (a.isLessThanOrEqual(b)) {
      this.start = a;
      this.end = b;
    } else {
      this.start = b;
      this.end = a;
    }
  }

  copy(): Range {
    return new Range(this.start.copy(), this.end.copy());
  }

  negate(): Range {
    return new Range(this.start.negate(), this.end.negate());
  }

  /** Make this Range (and its endpoints) immutable, and return it. */
  freeze(): this {
    this.start.freeze();
    this.end.freeze();
    return Object.freeze(this);
  }

  // --- Shape -----------------------------------------------------------------

  /** True when the range covers no characters (`start === end`). */
  isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  /** True when start and end are on the same row. */
  isSingleLine(): boolean {
    return this.start.row === this.end.row;
  }

  /** Number of rows the range touches, inclusive of both endpoints' rows. */
  getRowCount(): number {
    return this.end.row - this.start.row + 1;
  }

  /** The list of row indices the range touches. */
  getRows(): number[] {
    const rows: number[] = [];
    for (let row = this.start.row; row <= this.end.row; row++) rows.push(row);
    return rows;
  }

  /** The extent as a delta point: `end.traversalFrom(start)`. */
  getExtent(): Point {
    return this.end.traversalFrom(this.start);
  }

  // --- Combination -----------------------------------------------------------

  /** The smallest range covering both this and `other`. */
  union(other: Range): Range {
    const start = this.start.isLessThan(other.start) ? this.start : other.start;
    const end = this.end.isGreaterThan(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  /** Shift both endpoints; `endDelta` defaults to `startDelta`. */
  translate(startDelta: PointLike, endDelta: PointLike = startDelta): Range {
    return new Range(this.start.translate(startDelta), this.end.translate(endDelta));
  }

  /** Walk both endpoints forward by `delta` in reading order. */
  traverse(delta: PointLike): Range {
    return new Range(this.start.traverse(delta), this.end.traverse(delta));
  }

  // --- Comparison ------------------------------------------------------------

  /** Order by start, then by end descending (wider range first on a tie). */
  compare(other: RangeLike): -1 | 0 | 1 {
    const o = Range.fromObject(other);
    const byStart = this.start.compare(o.start);
    if (byStart !== 0) return byStart;
    return o.end.compare(this.end);
  }

  isEqual(other: RangeLike): boolean {
    const o = Range.fromObject(other);
    return o.start.isEqual(this.start) && o.end.isEqual(this.end);
  }

  /** True when both ranges start and end on the same rows. */
  coversSameRows(other: Range): boolean {
    return this.start.row === other.start.row && this.end.row === other.end.row;
  }

  /**
   * True when the ranges overlap. With `exclusive`, ranges that merely touch at
   * a single shared endpoint do not count as intersecting.
   */
  intersectsWith(other: Range, exclusive = false): boolean {
    if (exclusive) {
      return !(this.end.isLessThanOrEqual(other.start) || this.start.isGreaterThanOrEqual(other.end));
    }
    return !(this.end.isLessThan(other.start) || this.start.isGreaterThan(other.end));
  }

  /** True when `other` lies entirely within this range. */
  containsRange(other: RangeLike, exclusive = false): boolean {
    const o = Range.fromObject(other);
    return this.containsPoint(o.start, exclusive) && this.containsPoint(o.end, exclusive);
  }

  /**
   * True when `point` lies within this range. With `exclusive`, points exactly
   * on `start` or `end` are not contained.
   */
  containsPoint(point: PointLike, exclusive = false): boolean {
    const p = Point.fromObject(point);
    if (exclusive) return p.isGreaterThan(this.start) && p.isLessThan(this.end);
    return p.isGreaterThanOrEqual(this.start) && p.isLessThanOrEqual(this.end);
  }

  /** True when `row` falls within the range's rows. */
  intersectsRow(row: number): boolean {
    return this.start.row <= row && row <= this.end.row;
  }

  /** True when the inclusive row span `[startRow, endRow]` overlaps the range. */
  intersectsRowRange(startRow: number, endRow: number): boolean {
    const lo = Math.min(startRow, endRow);
    const hi = Math.max(startRow, endRow);
    return this.start.row <= hi && lo <= this.end.row;
  }

  // --- Conversion ------------------------------------------------------------

  toString(): string {
    return `[${this.start} - ${this.end}]`;
  }
}
