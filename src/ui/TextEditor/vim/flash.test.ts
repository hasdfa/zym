import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operator.ts';
import './text-object.ts';
import './motion.ts';

Gtk.init();

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  // Whether the flash decoration is currently applied anywhere in the buffer.
  const flashing = (): boolean => {
    const tag = buffer.getTagTable().lookup('deco:vim-flash:flash');
    if (!tag) return false;
    for (let o = 0; o < buffer.getCharCount(); o++) {
      if (buffer.getIterAtOffset(o).hasTag(tag)) return true;
    }
    return false;
  };
  return { editor, vimState, run, at, flashing };
}

test('a yank flashes the operated range, then clears', async () => {
  const { run, at, flashing } = setup('hello world\n');
  at(0, 0);
  run('Yank');
  run('MoveToNextWord'); // yw -> flashes "hello "
  assert.equal(flashing(), true);
  await tick(350); // past the operator flash duration
  assert.equal(flashing(), false);
});

test('a new flash supersedes the previous one (no leak)', async () => {
  const { run, at, flashing } = setup('one two three\n');
  at(0, 0);
  run('Yank');
  run('MoveToNextWord');
  run('Yank');
  run('MoveToNextWord'); // a second flash
  assert.equal(flashing(), true);
  await tick(350);
  assert.equal(flashing(), false);
});
