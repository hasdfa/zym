/*
 * folds — compute foldable line ranges from the tree, kept pure so it's
 * unit-testable. Two sources:
 *
 *  - **Block folds**: a grammar's `folds.scm` query (`@fold` captures — incl.
 *    multi-line comments), or, when it ships none, the `foldTypes` node-type set.
 *    A node captured as `@fold.keepFooter` (instead of `@fold`) keeps its closing
 *    line on its own line when folded — for chained constructs like if/else and
 *    try/catch where the `}` line continues (`} else {`). See the grammar query
 *    convention in code-editing/folding.md.
 *  - **Run folds**: a run of >= 2 consecutive same-type siblings the grammar folds
 *    as a block (import statements, line comments) — collapse to the first line.
 *
 * A range `{startRow, endRow}` keeps `startRow` visible and hides
 * `startRow+1 .. endRow-1` when folded (SyntaxController.toggleFold), so a block's
 * closing-bracket line stays visible; a run's `endRow` is the line *after* the run
 * so everything but the first line collapses. Only ranges hiding >= 1 line are
 * kept, and at most one per start line (first wins).
 */

export interface FoldRange {
  startRow: number;
  endRow: number;
  // Whether the footer (`}`) joins the header onto ONE line when folded (import,
  // function, standalone if). False keeps the footer on its own line so a chained
  // construct reads 1-per-line (`if (x) {[N]` / `} else if (y) {…`).
  joinFooter: boolean;
}

// A grammar declares "keep the footer on its own line" by capturing the node as
// this instead of `@fold` (see folds.scm for if/else, try/catch).
const FOLD_KEEP_FOOTER = 'fold.keepFooter';

export function computeFoldRanges(
  root: any,
  foldsQuery: any | null,
  foldTypes: Set<string>,
  runTypeRe: RegExp,
): FoldRange[] {
  const seen = new Set<number>();
  const ranges: FoldRange[] = [];
  const add = (startRow: number, endRow: number, joinFooter = true): void => {
    if (endRow - startRow >= 2 && !seen.has(startRow)) {
      seen.add(startRow);
      ranges.push({ startRow, endRow, joinFooter });
    }
  };

  if (foldsQuery) {
    // A node can match both `@fold` and the more specific `@fold.keepFooter`; merge
    // per start row so keep-footer wins (it's the declared chained-construct case).
    const byRow = new Map<number, { endRow: number; keepFooter: boolean }>();
    for (const cap of foldsQuery.captures(root)) {
      const startRow = cap.node.startPosition.row;
      const endRow = cap.node.endPosition.row;
      if (endRow - startRow < 2) continue;
      const keep = cap.name === FOLD_KEEP_FOOTER;
      const cur = byRow.get(startRow);
      if (!cur) byRow.set(startRow, { endRow, keepFooter: keep });
      else if (keep) cur.keepFooter = true;
    }
    for (const [startRow, { endRow, keepFooter }] of byRow) add(startRow, endRow, !keepFooter);
  } else {
    walkFoldTypes(root, foldTypes, add);
  }
  walkRuns(root, runTypeRe, add);

  ranges.sort((a, b) => a.startRow - b.startRow);
  return ranges;
}

function walkFoldTypes(node: any, foldTypes: Set<string>, add: (s: number, e: number, j?: boolean) => void): void {
  // The node-type fallback (no folds query) doesn't express keep-footer → always join.
  if (foldTypes.has(node.type)) add(node.startPosition.row, node.endPosition.row);
  for (const child of node.namedChildren) if (child) walkFoldTypes(child, foldTypes, add);
}

/** Fold maximal runs of >= 2 consecutive same-type siblings matching `re`. */
function walkRuns(node: any, re: RegExp, add: (s: number, e: number) => void): void {
  const children: any[] = node.namedChildren;
  let i = 0;
  while (i < children.length) {
    const c = children[i];
    if (c && re.test(c.type)) {
      let j = i;
      while (j + 1 < children.length && children[j + 1] && children[j + 1].type === c.type) j++;
      // endRow = last member's row + 1 → folding hides every line but the first.
      if (j > i) add(children[i].startPosition.row, children[j].endPosition.row + 1);
      i = j + 1;
    } else {
      if (c) walkRuns(c, re, add);
      i++;
    }
  }
}
