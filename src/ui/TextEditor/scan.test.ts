import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from './EditorModel.ts';
import { Range } from '../../text/Range.ts';
import { type ScanMatchResult } from './EditorModel.ts';

Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('scan collects every match with correct buffer ranges', () => {
  const m = model('foo bar foo\n');
  const hits: string[] = [];
  const ranges: number[][][] = [];
  m.scan(/foo/g, ({ matchText, range }) => {
    hits.push(matchText);
    ranges.push([range.start.toArray(), range.end.toArray()]);
  });
  assert.deepEqual(hits, ['foo', 'foo']);
  assert.deepEqual(ranges, [[[0, 0], [0, 3]], [[0, 8], [0, 11]]]);
});

test('stop() ends the scan early', () => {
  const m = model('a a a a\n');
  let count = 0;
  m.scan(/a/g, ({ stop }) => {
    count++;
    if (count === 2) stop();
  });
  assert.equal(count, 2);
});

test('ranges map correctly across lines', () => {
  const m = model('ab\ncd\nef');
  const found: number[][] = [];
  m.scan(/[df]/g, ({ range }) => found.push(range.start.toArray()));
  assert.deepEqual(found, [[1, 1], [2, 1]]); // 'd' on row 1, 'f' on row 2
});

test('scanInBufferRange honors the range bounds', () => {
  const m = model('foo\nfoo\nfoo\n');
  const rows: number[] = [];
  m.scanInBufferRange(/foo/g, new Range([1, 0], [2, 0]), ({ range }) => rows.push(range.start.row));
  assert.deepEqual(rows, [1]); // range text is "foo\n" — only the row-1 match
});

test('backwardsScanInBufferRange visits matches in reverse', () => {
  const m = model('one two one\n');
  const cols: number[] = [];
  m.backwardsScanInBufferRange(/one/g, new Range([0, 0], m.getEofBufferPosition()), ({ range }) =>
    cols.push(range.start.column),
  );
  assert.deepEqual(cols, [8, 0]);
});

test('backwardsScanInBufferRange spans its line-aligned windows correctly', () => {
  // > BACKWARD_SCAN_WINDOW_ROWS (200) lines so the reverse scan crosses windows.
  // "hit" appears on rows 5, 250, 480; reverse order must be exact and complete.
  const lines = Array.from({ length: 500 }, (_, i) => (i === 5 || i === 250 || i === 480 ? 'hit' : `line ${i}`));
  const m = model(lines.join('\n') + '\n');
  const rows: number[] = [];
  m.backwardsScanInBufferRange(/hit/g, new Range([0, 0], m.getEofBufferPosition()), ({ range }) =>
    rows.push(range.start.row),
  );
  assert.deepEqual(rows, [480, 250, 5]);
});

test('backwardsScanInBufferRange with stop() finds the nearest match without reading to BOF', () => {
  const lines = Array.from({ length: 500 }, (_, i) => (i === 3 || i === 495 ? 'hit' : `line ${i}`));
  const m = model(lines.join('\n') + '\n');
  let first: number | null = null;
  let visits = 0;
  m.backwardsScanInBufferRange(/hit/g, new Range([0, 0], [499, 0]), ({ range, stop }) => {
    visits++;
    first = range.start.row;
    stop();
  });
  assert.equal(first, 495); // last match before the end
  assert.equal(visits, 1); // stopped immediately — didn't scan back to row 3
});

test('replace substitutes matches as one undo step', () => {
  const m = model('foo\n');
  m.scan(/o/g, ({ replace }: ScanMatchResult) => replace('0'));
  assert.equal(m.getText(), 'f00\n');
  m.undo();
  assert.equal(m.getText(), 'foo\n'); // both replacements reverted together
});
