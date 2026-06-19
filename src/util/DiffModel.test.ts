import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDiff,
  computeIntraLineDiff,
  diffBufferText,
  foldUnchanged,
  needsTrailingNewline,
  refineWordRanges,
  splitLines,
  splitSides,
} from './DiffModel.ts';

// Build a context/change line list from a compact spec: '.' is context, 'x' a
// change. Each char becomes one line (text = its 0-based index) of that kind.
const lineList = (spec: string) =>
  [...spec].map((c, i) => ({ kind: c === '.' ? 'context' : 'added', text: String(i) }));

const kinds = (text: string, other: string) => computeDiff(text, other).lines.map((l) => `${l.kind[0]}:${l.text}`);

describe('splitLines', () => {
  it('treats a single trailing newline as a terminator', () => {
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('a\n\n'), ['a', '']); // a genuine blank line is kept
  });
});

describe('computeDiff', () => {
  it('reports no changes and no hunks for identical text', () => {
    const model = computeDiff('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'context', 'context']);
    assert.deepEqual(model.hunks, []);
    assert.deepEqual(model.stats, { added: 0, removed: 0 });
  });

  it('marks added lines and tracks new rows', () => {
    const model = computeDiff('a\nc', 'a\nb\nc');
    assert.deepEqual(kinds('a\nc', 'a\nb\nc'), ['c:a', 'a:b', 'c:c']);
    assert.deepEqual(model.stats, { added: 1, removed: 0 });
    const added = model.lines.find((l) => l.kind === 'added')!;
    assert.equal(added.oldRow, null);
    assert.equal(added.newRow, 1);
  });

  it('marks removed lines and tracks old rows', () => {
    const model = computeDiff('a\nb\nc', 'a\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'removed', 'context']);
    assert.deepEqual(model.stats, { added: 0, removed: 1 });
    const removed = model.lines.find((l) => l.kind === 'removed')!;
    assert.equal(removed.oldRow, 1);
    assert.equal(removed.newRow, null);
  });

  it('renders a modified line as a removed + added pair in one hunk', () => {
    const model = computeDiff('a\nB\nc', 'a\nb\nc');
    assert.deepEqual(model.lines.map((l) => l.kind), ['context', 'removed', 'added', 'context']);
    assert.equal(model.hunks.length, 1);
    assert.deepEqual(
      { start: model.hunks[0].startRow, count: model.hunks[0].rowCount, ...model.stats },
      { start: 1, count: 2, added: 1, removed: 1 },
    );
  });

  it('groups separate changed regions into separate hunks', () => {
    const model = computeDiff('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE');
    assert.equal(model.hunks.length, 2);
    assert.equal(model.hunks[0].oldStart, 1); // 'b' → 'B'
    assert.equal(model.hunks[1].oldStart, 4); // 'e' → 'E'
  });

  it('handles whole-file insert and delete', () => {
    assert.deepEqual(computeDiff('', 'x\ny').lines.map((l) => l.kind), ['added', 'added']);
    assert.deepEqual(computeDiff('x\ny', '').lines.map((l) => l.kind), ['removed', 'removed']);
  });
});

describe('computeIntraLineDiff', () => {
  it('finds the changed char spans on each side', () => {
    const { oldRanges, newRanges, hasCommon } = computeIntraLineDiff('const x = 1', 'const x = 2');
    assert.ok(hasCommon);
    assert.deepEqual(oldRanges, [[10, 11]]); // the '1'
    assert.deepEqual(newRanges, [[10, 11]]); // the '2'
  });

  it('reports no common content for a wholesale replacement', () => {
    const { hasCommon } = computeIntraLineDiff('aaaa', 'bbbb');
    assert.equal(hasCommon, false);
  });
});

describe('refineWordRanges', () => {
  it('keeps a localized span untouched', () => {
    assert.deepEqual(refineWordRanges('foo = 2', [[6, 7]]), [[6, 7]]);
  });

  it('merges spans separated only by whitespace into one (covering the gap)', () => {
    // 'aa x y z': 'x','y','z' changed with single-space gaps → one span [3,8); the
    // unchanged 'aa ' prefix keeps it from being promoted to a line background.
    assert.deepEqual(refineWordRanges('aa x y z', [[3, 4], [5, 6], [7, 8]]), [[3, 8]]);
  });

  it('does not merge across a span of non-whitespace common text', () => {
    // 'x bar z': the ' bar ' between the changed ends is not blank → stays split.
    assert.deepEqual(refineWordRanges('x bar z', [[0, 1], [6, 7]]), [[0, 1], [6, 7]]);
  });

  it('promotes a lone full-coverage span to the line background (empty result)', () => {
    assert.deepEqual(refineWordRanges('bar', [[0, 3]]), []);
    assert.deepEqual(refineWordRanges('  bar', [[2, 5]]), []); // flanked by indentation
  });

  it('promotes a whole-line change after merging', () => {
    // every word changed, blank gaps → merge to one span → promote to line bg.
    assert.deepEqual(refineWordRanges('FOO BAR', [[0, 3], [4, 7]]), []);
  });

  it('returns empty for no ranges', () => {
    assert.deepEqual(refineWordRanges('foo', []), []);
  });
});

describe('computeDiff word ranges', () => {
  it('annotates a modified line pair and skips wholesale replacements', () => {
    const model = computeDiff('foo = 1\nxxxx', 'foo = 2\nyyyy');
    const removed = model.lines.find((l) => l.kind === 'removed' && l.text === 'foo = 1')!;
    const added = model.lines.find((l) => l.kind === 'added' && l.text === 'foo = 2')!;
    assert.deepEqual(removed.wordRanges, [[6, 7]]);
    assert.deepEqual(added.wordRanges, [[6, 7]]);
    // 'xxxx' → 'yyyy' shares nothing → no intra-line annotation.
    assert.equal(model.lines.find((l) => l.text === 'xxxx')!.wordRanges, undefined);
  });

  it('drops a full-line word change to just the line background', () => {
    // 'aaa bbb' shares the ' ' with 'xxx yyy' → annotated, but every word changed,
    // so the merged span covers the whole line → no word ranges (line bg only).
    const model = computeDiff('aaa bbb', 'xxx yyy');
    assert.equal(model.lines.find((l) => l.kind === 'removed')!.wordRanges, undefined);
    assert.equal(model.lines.find((l) => l.kind === 'added')!.wordRanges, undefined);
  });

  it('carries word ranges through to side-by-side rows', () => {
    const { left, right } = splitSides(computeDiff('foo = 1', 'foo = 2'));
    assert.deepEqual(left.find((l) => l.kind === 'removed')!.wordRanges, [[6, 7]]);
    assert.deepEqual(right.find((l) => l.kind === 'added')!.wordRanges, [[6, 7]]);
  });
});

describe('diffBufferText / needsTrailingNewline', () => {
  const L = (kind: string, text: string) => ({ kind, text });

  it('does not terminate when the last line is non-empty', () => {
    const lines = [L('context', 'a'), L('added', 'b')];
    assert.equal(needsTrailingNewline(lines), false);
    assert.equal(diffBufferText(lines), 'a\nb'); // no spurious trailing blank row
  });

  it('terminates an empty *changed* last line (so it can carry its background)', () => {
    const lines = [L('context', 'a'), L('added', '')];
    assert.equal(needsTrailingNewline(lines), true);
    assert.equal(diffBufferText(lines), 'a\n\n');
  });

  it('does not terminate an empty *context* last line (no background to carry)', () => {
    const lines = [L('added', 'a'), L('context', '')];
    assert.equal(needsTrailingNewline(lines), false);
    assert.equal(diffBufferText(lines), 'a\n');
  });

  it('honours a forced terminator (side-by-side lockstep)', () => {
    const lines = [L('removed', 'a')];
    assert.equal(diffBufferText(lines, true), 'a\n');
    assert.equal(diffBufferText(lines, false), 'a');
  });

  it('handles an empty line list', () => {
    assert.equal(needsTrailingNewline([]), false);
    assert.equal(diffBufferText([]), '');
  });
});

describe('splitSides', () => {
  const sides = (a: string, b: string) => splitSides(computeDiff(a, b));

  it('keeps both panes equal length and aligns context', () => {
    const { left, right } = sides('a\nb\nc', 'a\nb\nc');
    assert.equal(left.length, right.length);
    assert.deepEqual(left.map((l) => l.text), ['a', 'b', 'c']);
    assert.deepEqual(right.map((l) => l.text), ['a', 'b', 'c']);
    assert.ok(left.every((l) => l.kind === 'context'));
  });

  it('pairs a modified line (removed left, added right) on the same row', () => {
    const { left, right } = sides('a\nB\nc', 'a\nb\nc');
    assert.deepEqual(left.map((l) => `${l.kind[0]}:${l.text}`), ['c:a', 'r:B', 'c:c']);
    assert.deepEqual(right.map((l) => `${l.kind[0]}:${l.text}`), ['c:a', 'a:b', 'c:c']);
  });

  it('pads the shorter side of an uneven change with fillers', () => {
    // old has one line, new has two → right gains a line; left pads with a filler.
    const { left, right } = sides('a\nx\nb', 'a\nx1\nx2\nb');
    assert.equal(left.length, right.length);
    const change = left.findIndex((l) => l.kind !== 'context');
    assert.equal(left[change].kind, 'removed'); // 'x'
    assert.equal(left[change + 1].kind, 'filler'); // pad for the extra new line
    assert.equal(right[change].kind, 'added');
    assert.equal(right[change + 1].kind, 'added');
  });

  it('pure insert pads the left side', () => {
    const { left, right } = sides('a\nc', 'a\nb\nc');
    assert.deepEqual(left.map((l) => l.kind), ['context', 'filler', 'context']);
    assert.deepEqual(right.map((l) => l.kind), ['context', 'added', 'context']);
  });
});

describe('foldUnchanged', () => {
  it('collapses a long interior context run, anchoring below the kept context', () => {
    // change, 10 context, change → keep 3 lines each side, hide the middle 4.
    const folds = foldUnchanged(lineList('x..........x'));
    assert.deepEqual(folds, [
      { anchorRow: 3, placement: 'below', bodyStart: 4, bodyEnd: 7, count: 4 },
    ]);
  });

  it('leaves a short context run alone', () => {
    assert.deepEqual(foldUnchanged(lineList('x....x')), []);
  });

  it('folds a leading context run, anchoring above the first visible line', () => {
    const folds = foldUnchanged(lineList('......x'));
    assert.deepEqual(folds, [
      { anchorRow: 3, placement: 'above', bodyStart: 0, bodyEnd: 2, count: 3 },
    ]);
  });

  it('folds a trailing context run to the end of the file', () => {
    const folds = foldUnchanged(lineList('x......'));
    assert.deepEqual(folds, [
      { anchorRow: 3, placement: 'below', bodyStart: 4, bodyEnd: 6, count: 3 },
    ]);
  });

  it('folds the two side-by-side panes identically (so they stay aligned)', () => {
    const ctx = Array.from({ length: 10 }, (_, i) => `c${i}`).join('\n');
    const { left, right } = splitSides(computeDiff(`OLD\n${ctx}`, `NEW\n${ctx}`));
    assert.deepEqual(foldUnchanged(left), foldUnchanged(right));
    assert.equal(foldUnchanged(left).length, 1);
  });
});
