import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import { CursorType } from '../EditorModel.ts';
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
  // The row the block-caret tag is painted on (the visible cursor line).
  const caretRow = (): number | null => {
    const tag = buffer.getTagTable().lookup('vim-block-cursor')!;
    for (let o = 0; o < buffer.getCharCount(); o++) {
      const iter = buffer.getIterAtOffset(o);
      if (iter.hasTag(tag)) return iter.getLine();
    }
    return null; // EOL / native caret
  };
  return { editor, vimState, run, at, caretRow };
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

test('linewise visual extends upward with the far end anchored (Vkk)', () => {
  const { editor, run, at } = setup('l0\nl1\nl2\nl3\nl4\n');
  at(2, 0); // line 2
  run('ActivateLinewiseVisualMode');
  // getBufferRowRange end is the linewise (row+1,0) boundary, so [2,3] == line 2.
  assert.deepEqual(editor.getLastSelection().getBufferRowRange(), [2, 3]);
  run('MoveUp'); // Vk -> lines 1-2 (bottom stays at 2)
  assert.deepEqual(editor.getLastSelection().getBufferRowRange(), [1, 3]);
  run('MoveUp'); // Vkk -> lines 0-2
  assert.deepEqual(editor.getLastSelection().getBufferRowRange(), [0, 3]);
  run('MoveDown'); // back down -> lines 1-2
  assert.deepEqual(editor.getLastSelection().getBufferRowRange(), [1, 3]);
});

test('linewise visual upward then delete removes the right lines', () => {
  const { editor, run, at } = setup('l0\nl1\nl2\nl3\n');
  at(2, 0);
  run('ActivateLinewiseVisualMode');
  run('MoveUp'); // select lines 1-2
  run('Delete');
  assert.equal(editor.getText(), 'l0\nl3\n');
});

test('linewise visual caret stays on the cursor line, not the next line', () => {
  const { editor, run, at, caretRow } = setup('l0\nl1\nl2\nl3\nl4\n');
  at(2, 0);
  editor.setCursorType(CursorType.BLOCK);
  run('ActivateLinewiseVisualMode');
  assert.equal(caretRow(), 2); // V: caret on line 2 (not the (3,0) selection boundary)
  run('MoveUp');
  assert.equal(caretRow(), 1); // Vk: caret on line 1
  run('MoveDown');
  run('MoveDown');
  assert.equal(caretRow(), 3); // back down past the anchor: caret on line 3
});
