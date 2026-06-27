import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';

Gtk.init();

// Search-as-motion drives the host's SearchBar for input. Headless, we stand in a
// provider that captures the request and resolves it *after* the keys are pushed —
// mirroring the real async bar (the user types, then presses Enter). `confirm`
// hands back a match point (what the seated match's start would be); `cancel`
// models Esc.
function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  let pending: { reverse?: boolean; onConfirm(p: Point | null): void; onCancel(): void } | null = null;
  let lastReverse: boolean | undefined;
  vimState.setSearchInput((req: typeof pending) => {
    pending = req;
    lastReverse = req!.reverse;
  });
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const confirm = (point: Point) => {
    const req = pending!;
    pending = null;
    req.onConfirm(point);
  };
  const cancel = () => {
    const req = pending!;
    pending = null;
    req.onCancel();
  };
  return { editor, vimState, run, at, confirm, cancel, reverse: () => lastReverse };
}

test('d/ deletes up to (excluding) the match — exclusive motion', () => {
  const { editor, run, at, confirm } = setup('foo bar foo baz\n');
  at(0, 0);
  run('Delete');
  run('Search');
  confirm(new Point(0, 8)); // the user searched "foo"; bar seats on the 2nd one
  assert.equal(editor.getText(), 'foo baz\n');
});

test('y/ yanks up to the match without changing the buffer', () => {
  const { editor, vimState, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('Yank');
  run('Search');
  confirm(new Point(0, 8));
  assert.equal(vimState.register.getText('"'), 'foo bar ');
  assert.equal(editor.getText(), 'foo bar baz\n');
});

test('cancelling the search (Esc) aborts the operator and returns to normal', () => {
  const { editor, vimState, run, at, cancel } = setup('foo bar foo\n');
  at(0, 0);
  run('Delete');
  run('Search');
  cancel();
  assert.equal(editor.getText(), 'foo bar foo\n'); // unchanged
  assert.ok(vimState.isMode('normal'));
});

test('d? searches backward (reverse flag) and deletes the span behind the cursor', () => {
  const { editor, run, at, confirm, reverse } = setup('foo bar foo baz\n');
  at(0, 14);
  run('Delete');
  run('SearchBackwards');
  assert.equal(reverse(), true);
  confirm(new Point(0, 8));
  assert.equal(editor.getText(), 'foo bar z\n');
});

test('visual / extends the selection to the match (cursor on the match)', () => {
  const { editor, vimState, run, at, confirm } = setup('foo bar foo baz\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('Search'); // v/foo
  confirm(new Point(0, 8));
  assert.ok(vimState.isMode('visual'));
  // The selection runs from the origin to the match, inclusive of the cursor
  // cell (visual is always select-righted), so it spans [0,0)-(0,9).
  const range = editor.getLastSelection().getBufferRange();
  assert.deepEqual(range.start.toArray(), [0, 0]);
  assert.deepEqual(range.end.toArray(), [0, 9]);
});
