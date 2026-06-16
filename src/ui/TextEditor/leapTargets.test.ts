import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import {
  computeLeapTargets,
  assignLeapLabels,
  resolveLeapChoice,
  safeLeapLabels,
  leapNextChars,
  pageCount,
} from './leapTargets.ts';

Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

const whole = (m: EditorModel) => new Range(new Point(0, 0), m.getEofBufferPosition());

test('computeLeapTargets finds forward matches after the cursor, nearest-first', () => {
  const m = model('ab xy ab xy ab\n');
  const targets = computeLeapTargets(m, 'ab', {
    reverse: false,
    cursor: new Point(0, 0),
    range: whole(m),
  });
  // The "ab" at column 0 is at the cursor (excluded); the next two follow.
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[0, 6], [0, 12]]);
});

test('computeLeapTargets bidirectional keeps both sides, nearest-first (forward wins ties)', () => {
  const m = model('ab.ab.ab.ab.ab\n'); // matches at cols 0,3,6,9,12
  const targets = computeLeapTargets(m, 'ab', {
    reverse: false,
    cursor: new Point(0, 6), // sitting on the middle "ab"
    range: whole(m),
    bidirectional: true,
  });
  // The match at the cursor (col 6) is excluded; the rest order by distance,
  // forward winning the col-3-each-way tie.
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[0, 9], [0, 3], [0, 12], [0, 0]]);
});

test('computeLeapTargets backward keeps matches before the cursor, nearest-first', () => {
  const m = model('ab xy ab xy ab\n');
  const targets = computeLeapTargets(m, 'ab', {
    reverse: true,
    cursor: new Point(0, 12),
    range: whole(m),
  });
  // Before column 12: cols 6 then 0, ordered closest-first (descending).
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[0, 6], [0, 0]]);
});

test('computeLeapTargets matches across lines within the range', () => {
  const m = model('foo\nfox\nfob\n');
  const targets = computeLeapTargets(m, 'fo', {
    reverse: false,
    cursor: new Point(0, 0),
    range: whole(m),
  });
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[1, 0], [2, 0]]);
});

test('computeLeapTargets treats the pattern literally (regex chars escaped)', () => {
  const m = model('a.b a.b axb\n');
  const targets = computeLeapTargets(m, 'a.', {
    reverse: false,
    cursor: new Point(0, 0),
    range: whole(m),
  });
  // Only the literal "a." pairs match; "ax" does not.
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[0, 4]]);
});

test('computeLeapTargets is case-sensitive', () => {
  const m = model('Ab ab AB ab\n');
  const targets = computeLeapTargets(m, 'ab', {
    reverse: false,
    cursor: new Point(0, 0),
    range: whole(m),
  });
  assert.deepEqual(targets.map((t) => t.start.toArray()), [[0, 3], [0, 9]]);
});

test('leapNextChars collects the character following each match', () => {
  const m = model('foo for fox\n');
  // Forward from col 0 excludes "foo"@0; matches "for"@4 and "fox"@8.
  const targets = computeLeapTargets(m, 'fo', { reverse: false, cursor: new Point(0, 0), range: whole(m) });
  const next = leapNextChars(m, targets);
  assert.ok(next.has('r')); // "for"
  assert.ok(next.has('x')); // "fox"
  assert.ok(!next.has('o'));
});

test('safeLeapLabels drops characters that could be the next search char', () => {
  const labels = safeLeapLabels(new Set(['o', 'r']));
  assert.ok(!labels.includes('o'));
  assert.ok(!labels.includes('r'));
  assert.ok(labels.includes('s')); // unaffected labels remain
});

// Fake targets (the choice/label fns only read `.start` and `.length`), so paging
// can be exercised with an explicit small label set instead of a 26+-match buffer.
const fakeTargets = (n: number): Range[] =>
  Array.from({ length: n }, (_, i) => new Range(new Point(i, 0), new Point(i, 2)));
const LS = 'sfn'; // 3 labels/page → deterministic paging

test('assignLeapLabels labels the current page window; off-page targets get no label', () => {
  const targets = fakeTargets(7);
  const page0 = assignLeapLabels(targets, LS, 0).labeled;
  assert.deepEqual(page0.map((t) => t.label), ['s', 'f', 'n', '', '', '', '']); // dots after page
  const page1 = assignLeapLabels(targets, LS, 1).labeled;
  assert.deepEqual(page1.map((t) => t.label), ['', '', '', 's', 'f', 'n', '']); // window shifts
});

test('assignLeapLabels keeps a target label across narrowing (stability)', () => {
  const a = new Range(new Point(0, 0), new Point(0, 2));
  const b = new Range(new Point(0, 5), new Point(0, 7));
  const c = new Range(new Point(0, 9), new Point(0, 11));
  const round1 = assignLeapLabels([a, b, c], LS, 0); // a→s, b→f, c→n
  assert.deepEqual(round1.labeled.map((t) => t.label), ['s', 'f', 'n']);
  // Narrow: `a` drops out; `b` is now nearest but must keep its 'f'.
  const round2 = assignLeapLabels([b, c], LS, 0, round1.assigned);
  assert.deepEqual(round2.labeled.map((t) => t.label), ['f', 'n']); // not ['s','f']
});

test('assignLeapLabels yields all dots when no labels are free', () => {
  assert.deepEqual(assignLeapLabels(fakeTargets(3), '', 0).labeled.map((t) => t.label), ['', '', '']);
});

test('resolveLeapChoice jumps to a target by its shown label', () => {
  const { labeled } = assignLeapLabels(fakeTargets(7), LS, 0);
  assert.deepEqual(resolveLeapChoice(labeled, 0, 3, 's'), { kind: 'jump', point: labeled[0].range.start });
  assert.deepEqual(resolveLeapChoice(labeled, 0, 3, 'n'), { kind: 'jump', point: labeled[2].range.start });
});

test('resolveLeapChoice pages with Space only when there is more than one page', () => {
  const { labeled } = assignLeapLabels(fakeTargets(7), LS, 0);
  assert.deepEqual(resolveLeapChoice(labeled, 0, 3, ' '), { kind: 'page', page: 1 });
  const single = assignLeapLabels(fakeTargets(2), LS, 0).labeled;
  assert.deepEqual(resolveLeapChoice(single, 0, 1, ' '), { kind: 'miss' }); // single page
});

test('resolveLeapChoice on the last page wraps to the first', () => {
  const { labeled } = assignLeapLabels(fakeTargets(7), LS, 2); // pages [0,1,2]
  assert.deepEqual(resolveLeapChoice(labeled, 2, 3, ' '), { kind: 'page', page: 0 });
});

test('resolveLeapChoice misses on a dot or unknown key (so it narrows instead)', () => {
  const { labeled } = assignLeapLabels(fakeTargets(7), LS, 0);
  assert.deepEqual(resolveLeapChoice(labeled, 0, 3, 'z'), { kind: 'miss' }); // not a label
});

test('pageCount counts label pages (and is 1 with no labels)', () => {
  assert.equal(pageCount(7, 3), 3);
  assert.equal(pageCount(6, 3), 2);
  assert.equal(pageCount(5, 0), 1);
});
