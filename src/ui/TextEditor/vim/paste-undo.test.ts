import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js';
import './motion.js';
import './operator.js';
import './operator-insert.js';
import './text-object.js';
import './misc-command.js';

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

test('p pastes the unnamed register after the cursor (characterwise)', () => {
  const { editor, vimState, run, at } = setup('abc\n');
  // yank "abc" via visual selection
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord');
  run('Yank'); // register = "abc"
  assert.equal(vimState.register.getText('"'), 'abc');

  at(0, 0);
  run('PutAfter'); // paste "abc" after column 0
  assert.equal(editor.getText(), 'aabcbc\n');
});

test('dd then p pastes the deleted line below (linewise)', () => {
  const { editor, run, at } = setup('one\ntwo\nthree\n');
  at(0, 0);
  run('Delete');
  run('Delete'); // dd -> "one\n" deleted, register linewise
  assert.equal(editor.getText(), 'two\nthree\n');
  run('PutAfter'); // p -> paste "one" line below current
  assert.equal(editor.getText(), 'two\none\nthree\n');
});

test('u undoes the last change and ctrl-r redoes it', () => {
  const { editor, run, at } = setup('hello world\n');
  at(0, 0);
  run('Delete');
  run('MoveToNextWord'); // dw -> "world"
  assert.equal(editor.getText(), 'world\n');

  run('Undo');
  assert.equal(editor.getText(), 'hello world\n');

  run('Redo');
  assert.equal(editor.getText(), 'world\n');
});
