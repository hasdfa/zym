/*
 * indent — compute a line's indent level from the tree-sitter tree, used as the
 * "real" indent source for the editor (`=` reindent, paste-reindent, new lines).
 *
 * Heuristic: a line's indent level is the number of enclosing *block* nodes — the
 * same multi-line constructs the grammar already marks as foldable (`foldTypes`:
 * `statement_block`, `object`, `array`, `arguments`, …). A block counts only when
 * it *strictly* spans the row (`startRow < row < endRow`), so a block's opening
 * line and its closing-bracket line both sit at the outer level while the body is
 * indented one deeper. Grammar-agnostic and column-independent (any column on the
 * row is inside the same set of spanning blocks).
 *
 * Kept here, separate from GTK, so it's unit-testable against a real parse.
 */

/** The indent level (enclosing fold-block depth) for `row` in `root`'s tree. */
export function indentLevelAt(root: any, row: number, foldTypes: Set<string>): number {
  let node: any = root.descendantForPosition({ row, column: 0 });
  let level = 0;
  while (node) {
    if (foldTypes.has(node.type) && node.startPosition.row < row && node.endPosition.row > row) {
      level++;
    }
    node = node.parent;
  }
  return level;
}

/** Whether the node at `(row, column)`, or any ancestor, has a type matching `re`
 *  — e.g. to tell if a position sits inside a string/comment/regex. */
export function enclosingTypeMatches(root: any, row: number, column: number, re: RegExp): boolean {
  let node: any = root.descendantForPosition({ row, column });
  while (node) {
    if (re.test(node.type)) return true;
    node = node.parent;
  }
  return false;
}

/** Outer (whole node) + inner (its `body` field's statements) line spans of a node. */
export interface NodeRowRange {
  outer: { startRow: number; endRow: number };
  inner: { startRow: number; endRow: number };
}

/**
 * The nearest node enclosing `(row, column)` whose type satisfies `matches`, as
 * outer (the whole construct) + inner (its `body` field's named children) line
 * spans — the backend for the function/class text objects. Null when none.
 */
export function enclosingNodeRange(
  root: any, row: number, column: number, matches: (type: string) => boolean,
): NodeRowRange | null {
  let node: any = root.descendantForPosition({ row, column });
  while (node && !matches(node.type)) node = node.parent;
  if (!node) return null;
  const outer = { startRow: node.startPosition.row, endRow: node.endPosition.row };
  let inner = outer;
  const body = node.childForFieldName ? node.childForFieldName('body') : null;
  if (body) {
    const stmts = (body.namedChildren || []).filter(Boolean);
    inner = stmts.length
      ? { startRow: stmts[0].startPosition.row, endRow: stmts[stmts.length - 1].endPosition.row }
      : { startRow: body.startPosition.row, endRow: body.endPosition.row };
  }
  return { outer, inner };
}
