import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource, Gdk } from '../../../gi.ts';
import { quilx } from '../../../quilx.ts';
import { EditorModel } from '../EditorModel.ts';
import { attachVim } from './index.ts';

Gtk.init();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Macros run through real keystroke dispatch, so drive keys through the window's
// `onWindowKeyPressEvent` against a focused view (like keymap-surround.test.ts).
function focusedEditor(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  attachVim(editor);
  editor.setCursorBufferPosition({ row: 0, column: 0 });

  const win = new Gtk.Window();
  win.setChild(view);
  quilx.window = win as never;
  win.present();
  view.grabFocus();

  const press = async (keyval: number) => {
    quilx.keymaps.onWindowKeyPressEvent(keyval, 0, 0);
    await tick(); // let async ops (readChar for the register letter) settle
  };
  const type = async (chars: string) => {
    for (const ch of chars) await press(Gdk.unicodeToKeyval(ch.charCodeAt(0)));
  };
  return { editor, view, press, type };
}

test('q records a macro and @ replays it', async () => {
  const { editor, type } = focusedEditor('abcdef\n');
  await type('qax'); // record into "a": delete a char
  await type('q'); // stop
  assert.equal(editor.getText(), 'bcdef\n'); // the recorded `x` ran once
  await type('@a');
  assert.equal(editor.getText(), 'cdef\n');
});

test('@@ repeats the last macro; a count multiplies it', async () => {
  const { editor, type } = focusedEditor('abcdefgh\n');
  await type('qaxq'); // macro a = [x]; deletes 'a'
  await type('@a'); // delete 'b'
  await type('@@'); // delete 'c'
  assert.equal(editor.getText(), 'defgh\n');
  await type('2@a'); // delete 'd','e'
  assert.equal(editor.getText(), 'fgh\n');
});

test('a macro replays an insert-mode edit', async () => {
  const { editor, type, press } = focusedEditor('one\ntwo\n');
  // Record `I>` <esc>: insert ">" at the start of the line. (Recording doesn't
  // route insert keys to GTK in this harness, so the buffer is unchanged here,
  // but the keystrokes are recorded and replay re-inserts them.)
  await type('qa');
  await type('I>');
  await press(Gdk.KEY_Escape);
  await type('q');
  editor.setCursorBufferPosition({ row: 1, column: 1 });
  await type('@a');
  assert.equal(editor.getText(), 'one\n>two\n');
});
