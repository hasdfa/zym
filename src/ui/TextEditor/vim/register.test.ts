import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import clipboard, { primaryClipboard } from './clipboard.ts';
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
  // Select register `reg`, the way pressing `"` then a letter does.
  const reg = (name: string) => {
    vimState.register.setName();
    vimState.setInputChar(name);
  };
  return { editor, vimState, run, at, reg };
}

test('"a yanks into the named register a', () => {
  const { vimState, run, at, reg } = setup('hello\nworld\n');
  at(0, 0);
  reg('a');
  run('YankLine');
  assert.equal(vimState.register.get('a')!.text, 'hello\n');
});

test('the register name clears after one operation', () => {
  const { vimState, run, at, reg } = setup('hello\nworld\n');
  at(0, 0);
  reg('a');
  run('YankLine'); // consumes the "a target
  assert.equal(vimState.register.name, null);
});

test('"ayy then "ap round-trips through the named register', () => {
  const { editor, run, at, reg } = setup('hello\nworld\n');
  at(0, 0);
  reg('a');
  run('YankLine'); // "ayy
  at(1, 0);
  reg('a');
  run('PutAfter'); // "ap
  assert.equal(editor.getText(), 'hello\nworld\nhello\n');
});

test('"+ writes to the system clipboard', () => {
  const { run, at, reg } = setup('clip me\n');
  at(0, 0);
  reg('+');
  run('YankLine');
  assert.equal(clipboard.read(), 'clip me\n');
});

test('"* targets the PRIMARY selection, distinct from "+ (CLIPBOARD)', () => {
  const { run, at, reg } = setup('primary me\n');
  clipboard.write('clipboard-untouched');
  at(0, 0);
  reg('*');
  run('YankLine'); // "*yy
  assert.equal(primaryClipboard.read(), 'primary me\n'); // landed in PRIMARY
  assert.equal(clipboard.read(), 'clipboard-untouched'); // CLIPBOARD left alone
});

test('"_ is the blackhole register (delete without touching the clipboard)', () => {
  const { run, at, reg } = setup('keep\ndrop\n');
  clipboard.write('untouched');
  at(1, 0);
  reg('_');
  run('DeleteLine'); // "_dd
  assert.equal(clipboard.read(), 'untouched'); // blackhole didn't overwrite it
});
