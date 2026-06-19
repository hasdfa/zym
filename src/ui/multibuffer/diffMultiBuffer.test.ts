/*
 * diffMultiBuffer tests (Phase 3b / G5 foundation) — pure, no GTK. Assembles a continuous
 * multi-file diff into ViewProjection items + per-row diff kinds, composed with the unified
 * ViewProjection to prove interleaving, editability (new editable / removed phantom), and the
 * row-kind alignment the surface uses for decorations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffMultiBuffer } from './diffMultiBuffer.ts';
import { ViewProjection, type Segment } from '../TextEditor/ViewProjection.ts';

function project(dmb: ReturnType<typeof buildDiffMultiBuffer>): ViewProjection {
  return ViewProjection.build(dmb.items, (s: Segment) => dmb.sources.get(s.sourceKey)!.slice(s.startRow, s.endRow + 1));
}

test('single-file diff: header + context/added/removed rows, kinds aligned', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' }]);
  const p = project(dmb);
  // rows: 0:a.ts(header) 1:a(ctx) 2:b(removed) 3:X(added) 4:c(ctx) 5:""(ctx, trailing)
  assert.equal(p.viewText, 'a.ts\na\nb\nX\nc\n');
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'removed', 'added', 'context', 'context']);
  // removed line maps to the OLD source (read-only phantom); added/context to the NEW source.
  assert.equal(p.isViewPositionEditable(2, 0), false, 'removed line is a read-only phantom');
  assert.equal(p.isViewPositionEditable(3, 0), true, 'added line is editable (new side)');
  assert.deepEqual(p.sourceRowAtViewRow(2), { sourceKey: 'old:/a.ts', sourceRow: 1 }, 'removed `b` from old blob');
  assert.deepEqual(p.sourceRowAtViewRow(3), { sourceKey: 'new:/a.ts', sourceRow: 1 }, 'added `X` from new');
});

test('per-row old/new line numbers (for the gutters): blank where a side has no line', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nc\n' }]);
  // rows: header, a(ctx), b(removed), X(added), c(ctx), ""(ctx)
  assert.deepEqual(dmb.oldNums, [null, 1, 2, null, 3, 4], 'removed has an old line; added has none');
  assert.deepEqual(dmb.newNums, [null, 1, null, 2, 3, 4], 'added has a new line; removed has none');
});

test('multi-file diff: blank separator + per-file headers, kinds aligned across files', () => {
  const dmb = buildDiffMultiBuffer([
    { path: '/a.ts', oldText: 'x\n', newText: 'x\ny\n' }, // add a line
    { path: '/b.ts', oldText: 'p\nq\n', newText: 'q\n' }, // remove a line
  ]);
  const p = project(dmb);
  // a.ts: header, x(ctx), y(added), ""(ctx)   blank   b.ts: header, p(removed), q(ctx), ""(ctx)
  assert.equal(p.viewText, 'a.ts\nx\ny\n\n\nb.ts\np\nq\n');
  assert.deepEqual(dmb.rowKinds, [
    'header', 'context', 'added', 'context',
    'blank',
    'header', 'removed', 'context', 'context',
  ]);
  assert.equal(dmb.rowKinds.length, p.viewRowCount, 'one kind per view row');
  // the second file's removed `p` resolves to b.ts's old blob.
  assert.deepEqual(p.sourceRowAtViewRow(6), { sourceKey: 'old:/b.ts', sourceRow: 0 });
});

test('header label is relative to cwd when given', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/repo/src/a.ts', oldText: 'a\n', newText: 'b\n' }], '/repo');
  assert.equal((dmb.items[0] as any).block.text, 'src/a.ts');
});

test('an unchanged file elides to a single gap row', () => {
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText: 'a\nb\n', newText: 'a\nb\n' }]);
  assert.deepEqual(dmb.rowKinds, ['header', 'gap']);
});

test('long unchanged runs are elided to a ⋯ gap; the change + context stay', () => {
  const base = Array.from({ length: 22 }, (_, i) => `L${i}`);
  const oldText = base.join('\n') + '\n';
  const changed = [...base];
  changed[1] = 'CHANGED';
  const newText = changed.join('\n') + '\n';
  const dmb = buildDiffMultiBuffer([{ path: '/a.ts', oldText, newText }]);
  // header, L0(ctx), L1-old(removed), L1-new(added), L2/L3/L4(ctx), then the rest elided.
  assert.deepEqual(dmb.rowKinds, ['header', 'context', 'removed', 'added', 'context', 'context', 'context', 'gap']);
  const gap = dmb.items[dmb.items.length - 1] as { type: 'block'; block: { kind: string; text: string } };
  assert.equal(gap.block.kind, 'gap');
  assert.match(gap.block.text, /^⋯ \d+ unchanged lines$/);
});
