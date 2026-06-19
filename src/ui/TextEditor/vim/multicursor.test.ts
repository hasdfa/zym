import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import { Range } from '../../../text/Range.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col = 0) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

test('addCursorBelow / addCursorAbove grow the cursor set; hasMultipleCursors flips', () => {
  const { editor, at } = setup('aaa\nbbb\nccc\n');
  at(0, 1);
  assert.equal(editor.hasMultipleCursors(), false);
  editor.addCursorBelow();
  editor.addCursorBelow();
  assert.equal(editor.hasMultipleCursors(), true);
  assert.deepEqual(
    editor.getCursorsOrderedByBufferPosition().map((c) => [c.getBufferPosition().row, c.getBufferPosition().column]),
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  );
});

test('addCursorBelow clamps the column to a shorter row and stops at the last row', () => {
  const { editor, at } = setup('hello\nhi\n');
  at(0, 4); // past the end of "hi"
  assert.ok(editor.addCursorBelow());
  assert.deepEqual(editor.getCursorsOrderedByBufferPosition().map((c) => c.getBufferPosition().column), [4, 2]);
  // Row 1 is the last text row (row 2 is the empty trailing line); below it exists,
  // but below that returns null.
  editor.setCursorBufferPosition(new Point(2, 0));
  assert.equal(editor.addCursorBelow(), null);
});

test('onDidAddSelection fires when a secondary selection is added', () => {
  const { editor, at } = setup('aaa\nbbb\n');
  at(0, 0);
  let fired = 0;
  editor.onDidAddSelection(() => fired++);
  editor.addCursorBelow();
  assert.equal(fired, 1);
});

test('mergeCursors collapses cursors that land on the same position', () => {
  const { editor, at } = setup('aaa\nbbb\n');
  at(0, 1);
  editor.addSelectionForBufferRange(new Range(new Point(0, 1), new Point(0, 1))); // duplicate of primary
  editor.addSelectionForBufferRange(new Range(new Point(1, 0), new Point(1, 0)));
  assert.equal(editor.getCursors().length, 3);
  editor.mergeCursors();
  assert.deepEqual(
    editor.getCursorsOrderedByBufferPosition().map((c) => [c.getBufferPosition().row, c.getBufferPosition().column]),
    [
      [0, 1],
      [1, 0],
    ],
  );
});

test('mergeIntersectingSelections merges overlapping ranges into one', () => {
  const { editor } = setup('abcdefgh\n');
  editor.setSelectedBufferRange(new Range(new Point(0, 0), new Point(0, 3)));
  editor.addSelectionForBufferRange(new Range(new Point(0, 2), new Point(0, 6))); // overlaps [0..3]
  editor.addSelectionForBufferRange(new Range(new Point(0, 7), new Point(0, 8))); // disjoint
  editor.mergeIntersectingSelections();
  assert.deepEqual(
    editor.getSelectedBufferRanges().map((r) => [r.start.column, r.end.column]).sort((a, b) => a[0] - b[0]),
    [
      [0, 6],
      [7, 8],
    ],
  );
});

test('persistent multi-cursor insert: `i` then type then escape inserts at every cursor', () => {
  const { editor, run, at } = setup('aaa\nbbb\nccc\n');
  at(0, 0);
  editor.addCursorBelow(); // cursor at (1,0)
  run('ActivateInsertMode'); // i
  editor.insertText('X'); // typed at the primary
  run('ActivateNormalMode'); // escape — replays to the other cursor
  assert.equal(editor.getText(), 'Xaaa\nXbbb\nccc\n');
});

test('multi-cursor insert is incremental: each typed chunk lands at every cursor immediately', async () => {
  const { editor, run, at } = setup('aaa\nbbb\nccc\n');
  at(0, 0);
  editor.addCursorBelow(); // (1,0)
  run('ActivateInsertMode');
  editor.insertText('X'); // first keystroke
  await Promise.resolve(); // replication is deferred one microtask off the change signal
  assert.equal(editor.getText(), 'Xaaa\nXbbb\nccc\n'); // already at both cursors, before escape
  editor.insertText('Y'); // second keystroke
  await Promise.resolve();
  assert.equal(editor.getText(), 'XYaaa\nXYbbb\nccc\n'); // and again
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'XYaaa\nXYbbb\nccc\n');
});

test('a multi-cursor operation undoes as a whole, not one cursor at a time', () => {
  const { editor, vimState, run, at } = setup('foo bar foo\nbaz foo qux\n');
  at(0, 0);
  run('Delete');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph'); // deletes all three `foo`
  assert.equal(editor.getText(), ' bar \nbaz  qux\n');
  editor.undo(); // a single undo restores every occurrence at once
  assert.equal(editor.getText(), 'foo bar foo\nbaz foo qux\n');
});

test('occurrence multi-cursor: `c o p` then type then escape changes every occurrence', () => {
  const { editor, vimState, run, at } = setup('foo bar foo\nbaz foo qux\n');
  at(0, 0);
  run('Change');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph'); // deletes every foo, enters insert with a cursor at each
  editor.insertText('X');
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'X bar X\nbaz X qux\n');
});
