import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import settings from './settings.ts';
import './operations/mode.js';
import './operator-insert.js';
import './text-object.js';
import './motion.js';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const pos = () => editor.getCursorBufferPosition().toArray();
  return { editor, vimState, run, at, pos };
}

test('h/l/j/k move the cursor by character and line', () => {
  const { run, at, pos } = setup('hello\nworld\n');
  at(0, 0);
  run('MoveRight');
  assert.deepEqual(pos(), [0, 1]);
  run('MoveDown');
  assert.deepEqual(pos(), [1, 1]);
  run('MoveLeft');
  assert.deepEqual(pos(), [1, 0]);
  run('MoveUp');
  assert.deepEqual(pos(), [0, 0]);
});

test('h stops at column 0; l reaches one past the last char (onemore default)', () => {
  const { run, at, pos } = setup('ab\n');
  at(0, 0);
  run('MoveLeft');
  assert.deepEqual(pos(), [0, 0]); // can't move before column 0
  run('MoveRight');
  assert.deepEqual(pos(), [0, 1]); // onto 'b'
  run('MoveRight');
  assert.deepEqual(pos(), [0, 2]); // past the last char (virtualedit=onemore)
  run('MoveRight');
  assert.deepEqual(pos(), [0, 2]); // but no further (end of line)
});

test('allowCursorPastEndOfLine=false restores the classic last-char resting', () => {
  settings.set('allowCursorPastEndOfLine', false);
  try {
    const { run, at, pos } = setup('ab\n');
    at(0, 1); // on 'b' (the last char)
    run('MoveRight');
    assert.deepEqual(pos(), [0, 1]); // pulled back to the last char
  } finally {
    settings.set('allowCursorPastEndOfLine', true);
  }
});

test('w / b / e move by word', () => {
  const { run, at, pos } = setup('foo bar baz\n');
  at(0, 0);
  run('MoveToNextWord');
  assert.deepEqual(pos(), [0, 4]); // start of "bar"
  run('MoveToNextWord');
  assert.deepEqual(pos(), [0, 8]); // start of "baz"
  run('MoveToPreviousWord');
  assert.deepEqual(pos(), [0, 4]); // back to "bar"
  run('MoveToEndOfWord');
  assert.deepEqual(pos(), [0, 6]); // end of "bar" (the 'r')
});

test('0 / ^ / $ move within the line', () => {
  const { run, at, pos } = setup('  hello world\n');
  at(0, 7);
  run('MoveToBeginningOfLine');
  assert.deepEqual(pos(), [0, 0]);
  run('MoveToFirstCharacterOfLine');
  assert.deepEqual(pos(), [0, 2]); // first non-blank
  run('MoveToLastCharacterOfLine');
  assert.deepEqual(pos(), [0, 13]); // end of line (onemore default; 'd' is at col 12)
});

test('gg / G jump to the first and last line', () => {
  const { run, at, pos } = setup('one\ntwo\nthree\n');
  at(1, 1);
  run('MoveToLastLine');
  assert.equal(pos()[0], 2); // last non-empty line
  run('MoveToFirstLine');
  assert.deepEqual(pos(), [0, 0]);
});

test('a count repeats a motion (3 l)', () => {
  const { editor, vimState, run, at, pos } = setup('abcdef\n');
  at(0, 0);
  vimState.operationStack.setCount(3);
  run('MoveRight');
  assert.deepEqual(pos(), [0, 3]);
});
