import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
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

// Leap-as-motion drives the host's Leap. Headless, we stand in a
// provider that captures the request and resolves it after the operation runs —
// mirroring the real flow (the user types 2 chars + a label, then a target Point
// comes back). `confirm` hands back a target point; `cancel` models Esc.
function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  let pending: { reverse?: boolean; onConfirm(p: Point | null): void; onCancel(): void } | null = null;
  let lastReverse: boolean | undefined;
  vimState.setLeapInput((req: typeof pending) => {
    pending = req;
    lastReverse = req!.reverse;
  });
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  const confirm = (point: Point | null) => {
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

test('g s jumps the cursor to the chosen target', () => {
  const { editor, vimState, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('Leap');
  confirm(new Point(0, 8)); // chose the label seated on "baz"
  assert.deepEqual(vimState.editor.getCursorBufferPosition().toArray(), [0, 8]);
  assert.equal(editor.getText(), 'foo bar baz\n'); // a jump, not an edit
});

test('d g s deletes up to (excluding) the target — exclusive motion', () => {
  const { editor, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('Delete');
  run('Leap');
  confirm(new Point(0, 8));
  assert.equal(editor.getText(), 'baz\n');
});

test('y g s yanks up to the target without changing the buffer', () => {
  const { editor, vimState, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('Yank');
  run('Leap');
  confirm(new Point(0, 8));
  assert.equal(vimState.register.getText('"'), 'foo bar ');
  assert.equal(editor.getText(), 'foo bar baz\n');
});

test('cancelling leap (Esc) aborts a pending operator and stays in normal mode', () => {
  const { editor, vimState, run, at, cancel } = setup('foo bar baz\n');
  at(0, 0);
  run('Delete');
  run('Leap');
  cancel();
  assert.equal(editor.getText(), 'foo bar baz\n'); // unchanged
  assert.ok(vimState.isMode('normal'));
});

test('no match / unknown label (null) aborts the operator', () => {
  const { editor, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('Delete');
  run('Leap');
  confirm(null);
  assert.equal(editor.getText(), 'foo bar baz\n');
});

test('g S passes the reverse flag for a backward leap', () => {
  const { editor, run, at, confirm, reverse } = setup('foo bar foo baz\n');
  at(0, 14);
  run('Delete');
  run('LeapBackwards');
  assert.equal(reverse(), true);
  confirm(new Point(0, 8)); // backward target seated on the 2nd "foo"
  assert.equal(editor.getText(), 'foo bar z\n');
});

test('visual g s extends the selection to the target', () => {
  const { editor, vimState, run, at, confirm } = setup('foo bar baz\n');
  at(0, 0);
  run('ActivateCharacterwiseVisualMode');
  run('Leap');
  confirm(new Point(0, 8));
  assert.ok(vimState.isMode('visual'));
  const range = editor.getLastSelection().getBufferRange();
  assert.deepEqual(range.start.toArray(), [0, 0]);
  assert.deepEqual(range.end.toArray(), [0, 9]); // select-righted past the cursor cell
});
