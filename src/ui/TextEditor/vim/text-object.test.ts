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

test('diw deletes the inner word under the cursor', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 5); // inside "bar"
  run('Delete');
  run('InnerWord');
  assert.equal(editor.getText(), 'foo  baz\n'); // "bar" gone, surrounding spaces kept
});

test('daw deletes a word including its trailing space', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 4); // start of "bar"
  run('Delete');
  run('AWord');
  assert.equal(editor.getText(), 'foo baz\n');
});

test('ciw changes the inner word and enters insert mode', () => {
  const { editor, vimState, run, at } = setup('foo bar baz\n');
  at(0, 5);
  run('Change');
  run('InnerWord');
  assert.equal(editor.getText(), 'foo  baz\n');
  assert.equal(vimState.mode, 'insert');
  // typing now inserts where "bar" was
  editor.insertText('X');
  assert.equal(editor.getText(), 'foo X baz\n');
});

test('di( deletes inside parentheses', () => {
  const { editor, run, at } = setup('call(a, b)\n');
  at(0, 6); // inside the parens
  run('Delete');
  run('InnerParenthesis');
  assert.equal(editor.getText(), 'call()\n');
});

test('ca( deletes the parentheses too', () => {
  const { editor, run, at } = setup('call(a, b)\n');
  at(0, 6);
  run('Change');
  run('AParenthesis');
  assert.equal(editor.getText(), 'call\n');
  assert.equal(editor.getText().includes('('), false);
});

test('cc changes the whole line, keeping it as one (linewise) edit', () => {
  const { editor, vimState, run, at } = setup('one\ntwo\nthree\n');
  at(1, 1);
  run('Change');
  run('Change'); // cc — repeated operator becomes linewise target
  assert.equal(vimState.mode, 'insert');
  assert.equal(editor.lineTextForBufferRow(1), ''); // line content cleared
  assert.equal(editor.getLineCount(), 4); // line still exists (one\n<empty>\nthree\n)
});
