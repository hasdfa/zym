import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiBufferProjection, GAP_LABEL, type Excerpt, type Segment } from './MultiBufferModel.ts';

// Pure coordinate-math tests — no GTK. The segment bodies are supplied by a resolver keyed
// off sourceKey, so the projection assembly is exercised in isolation (the place a stitched
// coordinate bug must surface, per the multibuffer plan).

const FILES: Record<string, string[]> = {
  'a.ts': ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
  'b.ts': ['B0', 'B1', 'B2'],
};
const resolve = (s: Segment): string[] => FILES[s.sourceKey].slice(s.startRow, s.endRow + 1);
const seg = (sourceKey: string, startRow: number, endRow: number): Segment =>
  ({ sourceKey, startRow, endRow, editable: false, kind: 'real' });

test('single excerpt, single segment: text + row mapping', () => {
  const excerpts: Excerpt[] = [{ header: 'a.ts', segments: [seg('a.ts', 1, 3)] }];
  const p = MultiBufferProjection.build(excerpts, resolve);
  assert.equal(p.text, 'a.ts\nl1\nl2\nl3\n', 'header + the 3 source rows, trailing newline');
  assert.equal(p.rowCount, 4);
  assert.equal(p.sourceAt(0), null, 'row 0 is the header');
  assert.deepEqual(
    { ...p.sourceAt(1)!, segment: undefined },
    { sourceKey: 'a.ts', sourceRow: 1, segment: undefined, excerptIndex: 0, segmentIndex: 0 },
    'row 1 maps to source row 1 (the segment start)',
  );
  assert.equal(p.sourceAt(3)!.sourceRow, 3, 'row 3 maps to source row 3');
  assert.equal(p.viewRowForSource('a.ts', 2), 2, 'source row 2 is shown at view row 2');
  assert.equal(p.viewRowForSource('a.ts', 6), null, 'a source row outside the segment is not shown');
});

test('multiple segments of one file get a gap row between them', () => {
  const excerpts: Excerpt[] = [{ header: 'a.ts', segments: [seg('a.ts', 0, 1), seg('a.ts', 4, 5)] }];
  const p = MultiBufferProjection.build(excerpts, resolve);
  // header, l0, l1, ⋯, l4, l5
  assert.equal(p.text, `a.ts\nl0\nl1\n${GAP_LABEL}\nl4\nl5\n`);
  assert.equal(p.sourceAt(3), null, 'the gap row is not a source row');
  assert.equal(p.sourceAt(4)!.sourceRow, 4, 'the second segment resumes at source row 4');
  assert.equal(p.sourceAt(4)!.segmentIndex, 1);
  assert.equal(p.viewRowForSource('a.ts', 4), 4);
});

test('multiple excerpts get a blank separator row and per-file headers', () => {
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('a.ts', 0, 0)] },
    { header: 'b.ts', segments: [seg('b.ts', 1, 2)] },
  ];
  const p = MultiBufferProjection.build(excerpts, resolve);
  // a.ts, l0, <blank>, b.ts, B1, B2
  assert.equal(p.text, 'a.ts\nl0\n\nb.ts\nB1\nB2\n');
  assert.equal(p.sourceAt(2), null, 'blank separator');
  assert.equal(p.sourceAt(3), null, 'b.ts header');
  assert.equal(p.sourceAt(4)!.sourceKey, 'b.ts');
  assert.equal(p.sourceAt(4)!.sourceRow, 1);
  assert.equal(p.viewRowForSource('b.ts', 2), 5);
});

test('entryAt binary search resolves every row to the right kind', () => {
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('a.ts', 0, 1), seg('a.ts', 4, 4)] },
    { header: 'b.ts', segments: [seg('b.ts', 0, 0)] },
  ];
  const p = MultiBufferProjection.build(excerpts, resolve);
  // 0:header 1:l0 2:l1 3:gap 4:l4 5:blank 6:header 7:B0
  const kinds = Array.from({ length: p.rowCount }, (_, r) => p.entryAt(r)!.kind);
  assert.deepEqual(kinds, ['header', 'segment', 'segment', 'gap', 'segment', 'blank', 'header', 'segment']);
  assert.equal(p.entryAt(-1), null);
  assert.equal(p.entryAt(p.rowCount), null);
});

test('segmentsInViewRange returns only the segments overlapping the visible rows', () => {
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('a.ts', 0, 2)] }, // rows 1..3
    { header: 'b.ts', segments: [seg('b.ts', 0, 2)] }, // rows 6..8
  ];
  const p = MultiBufferProjection.build(excerpts, resolve);
  // rows: 0 header, 1-3 a, 4 blank, 5 header, 6-8 b
  const inTop = p.segmentsInViewRange(0, 3).map((e) => e.segment.sourceKey);
  assert.deepEqual(inTop, ['a.ts'], 'only a.ts overlaps the top rows');
  const inBottom = p.segmentsInViewRange(6, 8).map((e) => e.segment.sourceKey);
  assert.deepEqual(inBottom, ['b.ts']);
  const inBoth = p.segmentsInViewRange(3, 6).map((e) => e.segment.sourceKey);
  assert.deepEqual(inBoth, ['a.ts', 'b.ts'], 'a range straddling the gap returns both');
});

test('isEditable reflects the segment flag (Phase 1a: read-only)', () => {
  const p1 = MultiBufferProjection.build([{ header: 'a.ts', segments: [seg('a.ts', 0, 0)] }], resolve);
  assert.equal(p1.isEditable(1), false, 'read-only segment row');
  assert.equal(p1.isEditable(0), false, 'header row');
  const editable: Segment = { sourceKey: 'a.ts', startRow: 0, endRow: 0, editable: true, kind: 'real' };
  const p2 = MultiBufferProjection.build([{ header: 'a.ts', segments: [editable] }], resolve);
  assert.equal(p2.isEditable(1), true, 'an editable real segment row (the Phase 2 seam)');
});

test('empty excerpt list yields empty text', () => {
  const p = MultiBufferProjection.build([], resolve);
  assert.equal(p.text, '');
  assert.equal(p.rowCount, 0);
  assert.equal(p.sourceAt(0), null);
});
