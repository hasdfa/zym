import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource, Gdk } from '../../../gi.ts';
import { quilx } from '../../../quilx.ts';
import { EditorModel } from '../EditorModel.ts';
import { attachVim } from './index.ts';
import clipboard from './clipboard.ts';

Gtk.init();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Build an editor whose view is the focused widget of `quilx.window`, so the
// KeymapManager's `getActiveElements()` resolves to it and real keystrokes
// (driven through `onWindowKeyPressEvent`) dispatch against its VimState.
function focusedEditor(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  attachVim(editor);

  editor.setCursorBufferPosition({ row: 0, column: 0 }); // setText leaves it at EOF

  const win = new Gtk.Window();
  win.setChild(view);
  quilx.window = win as never;
  win.present();
  view.grabFocus();

  const press = (char: string) => {
    const keyval = Gdk.unicodeToKeyval(char.charCodeAt(0));
    quilx.keymaps.onWindowKeyPressEvent(keyval, 0, 0);
  };
  const type = (chars: string) => {
    for (const ch of chars) press(ch);
  };
  const line = (row = 0) => editor.lineTextForBufferRow(row);
  return { editor, view, press, type, line };
}

test('ysiw( surrounds the inner word (deferral + input capture)', async () => {
  const { type, line } = focusedEditor('hello world\n');
  type('ysiw(');
  await tick();
  assert.equal(line(), '(hello) world');
});

test('dw still deletes a word (y/d deferral falls back to the operator)', () => {
  const { type, line } = focusedEditor('hello world\n');
  type('dw');
  assert.equal(line(), 'world');
});

test('yw still yanks a word (deferral fallback to Yank)', () => {
  const { type } = focusedEditor('hello world\n');
  type('yw');
  assert.equal(clipboard.read(), 'hello ');
});

test('ds( deletes the surrounding pair', async () => {
  const { editor, type, line } = focusedEditor('(hello) world\n');
  editor.setCursorBufferPosition({ row: 0, column: 3 }); // inside the parens
  type('ds(');
  await tick();
  assert.equal(line(), 'hello world');
});

test('g~iw toggles case (Key ~ fix + g~ binding through the keymap)', () => {
  const { type, line } = focusedEditor('Hello world\n');
  type('g~iw');
  assert.equal(line(), 'hELLO world');
});

// --- Preserved KeymapManager behaviors (no deferral conflict) ---------------

test('i enters insert mode immediately (full match, no partial)', () => {
  const { view, press } = focusedEditor('hello\n');
  press('i');
  assert.equal(view.getEditable(), true); // insert mode enables editing
});

test('gg jumps to the first line (plain key sequence)', () => {
  const { editor, type } = focusedEditor('one\ntwo\nthree\n');
  editor.setCursorBufferPosition({ row: 2, column: 1 });
  type('gg');
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 0]);
});

test('dd deletes a line (d deferral, then d resolves in operator-pending)', () => {
  const { type, line } = focusedEditor('one\ntwo\nthree\n');
  type('dd');
  assert.equal(line(0), 'two');
});
