import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js';
import './operator-insert.js';
import './text-object.js';
import './motion.js';
import './operator.js';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

test('dw deletes to the start of the next word', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 0);
  run('Delete');
  run('MoveToNextWord');
  assert.equal(editor.getText(), 'bar baz\n');
});

test('de deletes to the end of the word (inclusive)', () => {
  const { editor, run, at } = setup('foo bar\n');
  at(0, 0);
  run('Delete');
  run('MoveToEndOfWord');
  assert.equal(editor.getText(), ' bar\n'); // "foo" removed, space kept
});

test('dd deletes the whole line (linewise)', () => {
  const { editor, run, at } = setup('one\ntwo\nthree\n');
  at(1, 0);
  run('Delete');
  run('Delete'); // operation stack turns the repeated operator into a linewise target
  assert.equal(editor.getText(), 'one\nthree\n');
});

test('yw yanks into the unnamed register without changing the buffer', () => {
  const { editor, vimState, run, at } = setup('foo bar\n');
  at(0, 0);
  run('Yank');
  run('MoveToNextWord');
  assert.equal(editor.getText(), 'foo bar\n'); // unchanged
  assert.equal(vimState.register.getText('"'), 'foo '); // yanked text
});

test('the cursor lands at the start of a deleted word', () => {
  const { editor, run, at } = setup('alpha beta gamma\n');
  at(0, 6); // start of "beta"
  run('Delete');
  run('MoveToNextWord');
  assert.equal(editor.getText(), 'alpha gamma\n');
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 6]); // on "gamma"
});
