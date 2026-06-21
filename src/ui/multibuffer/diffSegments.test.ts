/*
 * diffSegments tests (Phase 3b foundation, docs/text-editor/multibuffer.md) — pure, no GTK.
 * The diff-duality coordinate model: context/added → editable new-side rows, removed →
 * read-only phantom old-side rows, composed with the unified ViewProjection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSegments } from './diffSegments.ts';
import { ViewProjection, type Segment } from '../TextEditor/ViewProjection.ts';

const segs = (items: ReturnType<typeof diffSegments>['items']): Segment[] =>
  items.filter((i) => i.type === 'segment').map((i) => (i as { segment: Segment }).segment);

test('all-unchanged: one editable new-side segment', () => {
  const { items, ops } = diffSegments(['a', 'b'], ['a', 'b'], 'new', 'old');
  assert.deepEqual(ops, ['eq', 'eq']);
  assert.deepEqual(segs(items), [{ sourceKey: 'new', startRow: 0, endRow: 1, editable: true, kind: 'real' }]);
});

test('pure addition: one editable new-side segment', () => {
  const { items, ops } = diffSegments([], ['a', 'b'], 'new', 'old');
  assert.deepEqual(ops, ['ins', 'ins']);
  assert.deepEqual(segs(items), [{ sourceKey: 'new', startRow: 0, endRow: 1, editable: true, kind: 'real' }]);
});

test('pure deletion: one read-only phantom old-side segment', () => {
  const { items, ops } = diffSegments(['a', 'b'], [], 'new', 'old');
  assert.deepEqual(ops, ['del', 'del']);
  assert.deepEqual(segs(items), [{ sourceKey: 'old', startRow: 0, endRow: 1, editable: false, kind: 'phantom' }]);
});

test('replace: removed line is phantom over old; added/context editable over new', () => {
  const { items, ops } = diffSegments(['a', 'b', 'c'], ['a', 'X', 'c'], 'new', 'old');
  assert.deepEqual(ops, ['eq', 'del', 'ins', 'eq']);
  assert.deepEqual(segs(items), [
    { sourceKey: 'new', startRow: 0, endRow: 0, editable: true, kind: 'real' }, // context 'a'
    { sourceKey: 'old', startRow: 1, endRow: 1, editable: false, kind: 'phantom' }, // removed 'b' (old row 1)
    { sourceKey: 'new', startRow: 1, endRow: 2, editable: true, kind: 'real' }, // added 'X' + context 'c'
  ]);
});

test('composed with ViewProjection: interleaves + gates editability correctly', () => {
  const oldLines = ['a', 'b', 'c'];
  const newLines = ['a', 'X', 'c'];
  const { items } = diffSegments(oldLines, newLines, 'new', 'old');
  const resolve = (s: Segment) => (s.sourceKey === 'new' ? newLines : oldLines).slice(s.startRow, s.endRow + 1);
  const p = ViewProjection.build(items, resolve);

  // view rows: 0:a (context) 1:b (removed/phantom) 2:X (added) 3:c (context)
  assert.equal(p.viewText, 'a\nb\nX\nc');
  assert.equal(p.isViewPositionEditable(0, 0), true, 'context is editable (the new doc)');
  assert.equal(p.isViewPositionEditable(1, 0), false, 'removed line is a read-only phantom');
  assert.equal(p.isViewPositionEditable(2, 0), true, 'added line is editable');
  assert.deepEqual(p.sourceRowAtViewRow(1), { sourceKey: 'old', sourceRow: 1 }, 'removed maps to the old blob');
  assert.deepEqual(p.sourceRowAtViewRow(2), { sourceKey: 'new', sourceRow: 1 }, 'added maps to the new doc');
});
