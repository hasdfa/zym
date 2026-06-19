import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import clipboard from './clipboard.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';
import './motion.ts';

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

test('clipboard write-through is readable synchronously', () => {
  clipboard.write('round-trip');
  assert.equal(clipboard.read(), 'round-trip');
});

test('yank writes to the system clipboard (useClipboardAsDefaultRegister)', () => {
  const { run, at } = setup('hello world\n');
  at(0, 0);
  run('Yank');
  run('MoveToNextWord'); // yw -> "hello "
  assert.equal(clipboard.read(), 'hello ');
});

test('paste reads from the system clipboard', () => {
  const { editor, run, at } = setup('XY\n');
  clipboard.write('PASTED');
  at(0, 0); // on 'X'
  run('PutAfter'); // p -> inserts after the cursor
  assert.equal(editor.lineTextForBufferRow(0), 'XPASTEDY');
});
