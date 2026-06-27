import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './operator-transform-string.ts';
import './text-object.ts';
import './motion.ts';
import './misc-command.ts';

Gtk.init();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const line = (row = 0) => editor.lineTextForBufferRow(row);
  return { editor, vimState, run, at, line };
}

test('gU / gu / g~ change the case of the target', () => {
  const { run, at, line } = setup('Hello World\n');
  at(0, 0);
  run('UpperCase');
  run('InnerWord');
  assert.equal(line(), 'HELLO World');
  at(0, 0);
  run('LowerCase');
  run('InnerWord');
  assert.equal(line(), 'hello World');
  at(0, 0);
  run('ToggleCase');
  run('InnerWord');
  assert.equal(line(), 'HELLO World'); // 'hello' -> 'HELLO'
});

test('r replaces count characters with the typed character', async () => {
  const { vimState, at, line } = setup('abcdef\n');
  at(0, 0);
  vimState.operationStack.setCount(3);
  vimState.operationStack.run('ReplaceCharacter');
  vimState.setInputChar('x');
  await tick();
  assert.equal(line(), 'xxxdef');
});

test('r at the line end with too few characters is a no-op', async () => {
  const { vimState, at, line } = setup('ab\n');
  at(0, 1); // on 'b', only 1 char to the right
  vimState.operationStack.setCount(3);
  vimState.operationStack.run('ReplaceCharacter');
  vimState.setInputChar('x');
  await tick();
  assert.equal(line(), 'ab'); // unchanged
});

test('ysiw-style surround wraps the inner word', async () => {
  const { vimState, at, line } = setup('hello\n');
  at(0, 0);
  vimState.operationStack.run('SurroundWord'); // target = InnerWord
  vimState.setInputChar('(');
  await tick();
  assert.equal(line(), '(hello)');
});

test('ds deletes the surrounding pair', async () => {
  const { vimState, at, line } = setup('(hello)\n');
  at(0, 3); // inside the parens
  vimState.operationStack.run('DeleteSurround');
  vimState.setInputChar('('); // which pair to delete
  await tick();
  assert.equal(line(), 'hello');
});

test('cs changes one surrounding pair into another', async () => {
  const { vimState, at, line } = setup('(hello)\n');
  at(0, 3);
  vimState.operationStack.run('ChangeSurround');
  vimState.setInputChar('('); // target pair to remove
  vimState.setInputChar('['); // replacement pair
  await tick();
  assert.equal(line(), '[hello]');
});

test('. repeats the last change (dw then .)', () => {
  const { vimState, at, line } = setup('one two three four\n');
  at(0, 0);
  vimState.operationStack.run('Delete');
  vimState.operationStack.run('MoveToNextWord'); // dw -> removes "one "
  assert.equal(line(), 'two three four');
  vimState.operationStack.runRecorded(); // . -> removes "two "
  assert.equal(line(), 'three four');
});

test('m sets a mark and ` jumps back to it', async () => {
  const { vimState, editor, at } = setup('line one\nline two\nline three\n');
  at(2, 2);
  vimState.operationStack.run('Mark');
  vimState.setInputChar('a');
  await tick();
  at(0, 0);
  vimState.operationStack.run('MoveToMark');
  vimState.setInputChar('a');
  await tick();
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [2, 2]);
});
