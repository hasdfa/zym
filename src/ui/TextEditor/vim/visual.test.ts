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

test('v enters characterwise visual mode', () => {
  const { vimState, run, at } = setup('hello\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  assert.ok(vimState.isMode('visual', 'characterwise'));
});

test('re-activating the current wise toggles back to normal', () => {
  const { vimState, run, at } = setup('hello\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('ActivateCharacterwiseVisualMode');
  assert.ok(vimState.isMode('normal'));
});

test('characterwise visual + motion + delete removes the selection', () => {
  const { editor, run, at } = setup('hello world\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord'); // select "hello"
  run('Delete');
  assert.equal(editor.getText(), ' world\n');
});

test('linewise visual + delete removes whole lines', () => {
  const { editor, vimState, run, at } = setup('one\ntwo\nthree\n');
  at(1, 0);
  run('ActivateLinewiseVisualMode');
  assert.ok(vimState.isMode('visual', 'linewise'));
  run('Delete');
  assert.equal(editor.getText(), 'one\nthree\n');
});

test('visual yank lands in the unnamed register and returns to normal', () => {
  const { editor, vimState, run, at } = setup('hello world\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('MoveToEndOfWord'); // "hello"
  run('Yank');
  assert.equal(editor.getText(), 'hello world\n'); // unchanged
  assert.equal(vimState.register.getText('"'), 'hello');
  assert.ok(vimState.isMode('normal')); // yank exits visual
});

test('visual text-object: viw selects the inner word, d deletes it', () => {
  const { editor, run, at } = setup('foo bar baz\n');
  at(0, 5); // inside "bar"
  run('ActivateCharacterwiseVisualMode');
  run('InnerWord');
  run('Delete');
  assert.equal(editor.getText(), 'foo  baz\n');
});
