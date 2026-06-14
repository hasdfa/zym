/*
 * Point — an immutable (row, column) position in a text buffer.
 *
 * Rows and columns are zero-based; a Point addresses the gap *before* a
 * character, so column 0 is the start of a line. Points are the atomic unit the
 * editor model and the vim layer use to talk about cursor positions and the
 * endpoints of a Range. Operations never mutate in place — they return a new
 * Point — so a Point can be shared freely without defensive copying.
 *
 * The API mirrors the well-known text-buffer `Point`, so motions/operators
 * ported from vim-mode-plus keep their exact semantics (notably the distinction
 * between `translate`, which adds componentwise, and `traverse`, which folds the
 * column into the new row when the row changes).
 */

/** Anything that can be coerced to a Point: a Point, `[row, column]`, or `{ row, column }`. */
export type PointLike = Point | [number, number] | { row: number; column: number };

export class Point {
  /** The origin, `(0, 0)`. Frozen; safe to share. */
  static readonly ZERO: Point = new Point(0, 0).freeze();
  /** A point past every real position, `(∞, ∞)`. Frozen; safe to share. */
  static readonly INFINITY: Point = new Point(Infinity, Infinity).freeze();

  /** Coerce `object` to a Point. With `copy`, always returns a fresh instance. */
  static fromObject(object: PointLike, copy = false): Point {
    if (object instanceof Point) return copy ? object.copy() : object;
    if (Array.isArray(object)) return new Point(object[0], object[1]);
    return new Point(object.row, object.column);
  }

  /** The lesser of two points (by row, then column). */
  static min(a: PointLike, b: PointLike): Point {
    const pa = Point.fromObject(a);
    const pb = Point.fromObject(b);
    return pa.isLessThanOrEqual(pb) ? pa : pb;
  }

  /** The greater of two points (by row, then column). */
  static max(a: PointLike, b: PointLike): Point {
    const pa = Point.fromObject(a);
    const pb = Point.fromObject(b);
    return pa.compare(pb) >= 0 ? pa : pb;
  }

  row: number;
  column: number;

  constructor(row = 0, column = 0) {
    this.row = row;
    this.column = column;
  }

  copy(): Point {
    return new Point(this.row, this.column);
  }

  negate(): Point {
    return new Point(-this.row, -this.column);
  }

  /** Make this Point immutable, and return it. */
  freeze(): this {
    return Object.freeze(this);
  }

  // --- Movement --------------------------------------------------------------

  /** Add `delta` componentwise: `(row + Δrow, column + Δcolumn)`. */
  translate(delta: PointLike): Point {
    const d = Point.fromObject(delta);
    return new Point(this.row + d.row, this.column + d.column);
  }

  /**
   * Walk forward by `delta` in reading order. When `delta.row` is 0 the columns
   * add; when it is non-zero the result lands on the new row at `delta.column`
   * (the original column is consumed by the row change) — the same semantics as
   * advancing through buffer text.
   */
  traverse(delta: PointLike): Point {
    const d = Point.fromObject(delta);
    if (d.row === 0) return new Point(this.row, this.column + d.column);
    return new Point(this.row + d.row, d.column);
  }

  /** The `delta` such that `other.traverse(delta)` equals this Point. */
  traversalFrom(other: PointLike): Point {
    const o = Point.fromObject(other);
    if (this.row === o.row) return new Point(0, this.column - o.column);
    return new Point(this.row - o.row, this.column);
  }

  // --- Comparison ------------------------------------------------------------

  /** -1 if this is before `other`, 1 if after, 0 if equal. */
  compare(other: PointLike): -1 | 0 | 1 {
    const o = Point.fromObject(other);
    if (this.row > o.row) return 1;
    if (this.row < o.row) return -1;
    if (this.column > o.column) return 1;
    if (this.column < o.column) return -1;
    return 0;
  }

  isEqual(other: PointLike): boolean {
    return this.compare(other) === 0;
  }
  isLessThan(other: PointLike): boolean {
    return this.compare(other) < 0;
  }
  isLessThanOrEqual(other: PointLike): boolean {
    return this.compare(other) <= 0;
  }
  isGreaterThan(other: PointLike): boolean {
    return this.compare(other) > 0;
  }
  isGreaterThanOrEqual(other: PointLike): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.row === 0 && this.column === 0;
  }
  isPositive(): boolean {
    return this.row > 0 || (this.row === 0 && this.column > 0);
  }
  isNegative(): boolean {
    return this.row < 0 || (this.row === 0 && this.column < 0);
  }

  // --- Conversion ------------------------------------------------------------

  toArray(): [number, number] {
    return [this.row, this.column];
  }

  toString(): string {
    return `(${this.row}, ${this.column})`;
  }
}
