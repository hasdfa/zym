import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel, CursorType } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './motion.ts';
import './operator.ts';
import './operator-insert.ts';
import './text-object.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setFocused(true); // an active editor paints the block caret (else focused=false hides it)
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col: number) => editor.setCursorBufferPosition(new Point(row, col));
  // ctrl-v on (0,1), then jjl: a 2-wide block over rows 0-2 (columns 1-2).
  const block = () => {
    run('ActivateBlockwiseVisualMode');
    run('MoveDown');
    run('MoveDown');
    run('MoveRight');
  };
  return { editor, vimState, run, at, block };
}

const GRID = 'abcde\nfghij\nklmno\npqrst\n';

test('ctrl-v enters blockwise visual mode', () => {
  const { vimState, run, at } = setup(GRID);
  at(0, 0);
  run('ActivateBlockwiseVisualMode');
  assert.ok(vimState.isMode('visual', 'blockwise'));
});

test('blockwise motion makes one selection per spanned row', () => {
  const { editor, at, block } = setup(GRID);
  at(0, 1);
  block();
  assert.equal(editor.getSelections().length, 3);
  assert.deepEqual(
    editor.getSelections().map((s) => s.getText()),
    ['bc', 'gh', 'lm'],
  );
});

test('blockwise carets sit on each row at the active column (no offset/gap/dup)', () => {
  const { editor, at, block } = setup(GRID);
  editor.setCursorType(CursorType.BLOCK);
  at(0, 1);
  block(); // rows 0-2, columns 1-2 ('bc'/'gh'/'lm'); the active column is 2
  const tag = (name: string) => editor.buffer.getTagTable().lookup(name);
  const positions = (name: string): Array<[number, number]> => {
    const t = tag(name);
    const out: Array<[number, number]> = [];
    if (!t) return out;
    for (let o = 0; o < editor.buffer.getCharCount(); o++) {
      const it = editor.buffer.getIterAtOffset(o);
      if (it.hasTag(t)) out.push([it.getLine(), it.getLineOffset()]);
    }
    return out;
  };
  const all = [...positions('vim-block-cursor'), ...positions('vim-extra-cursor')].sort(
    (a, b) => a[0] - b[0],
  );
  // Exactly one caret per row, each on the last selected char (col 2) — not the
  // select-right head (col 3), and no missing first row / doubled head row.
  assert.deepEqual(all, [
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
});

test('blockwise delete removes the column on every row and returns to normal', () => {
  const { editor, vimState, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('Delete');
  assert.equal(editor.getText(), 'ade\nfij\nkno\npqrst\n');
  assert.ok(vimState.isMode('normal'));
  assert.equal(editor.getSelections().length, 1); // extras collapsed
});

test('blockwise I inserts before the block on every row', () => {
  const { editor, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('InsertAtStartOfTarget');
  editor.insertText('XY');
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'aXYbcde\nfXYghij\nkXYlmno\npqrst\n');
  assert.equal(editor.getSelections().length, 1);
});

test('blockwise A appends after the block on every row', () => {
  const { editor, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('InsertAtEndOfTarget');
  editor.insertText('XY');
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'abcXYde\nfghXYij\nklmXYno\npqrst\n');
});

test('blockwise c changes the column on every row', () => {
  const { editor, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('Change');
  editor.insertText('XY');
  run('ActivateNormalMode');
  assert.equal(editor.getText(), 'aXYde\nfXYij\nkXYno\npqrst\n');
});

test('blockwise yank stores all rows and column-pastes them back', () => {
  const { editor, vimState, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('Yank');
  assert.equal(vimState.register.getText('"'), 'bc\ngh\nlm');
  assert.ok(vimState.isMode('normal'));
  editor.setCursorBufferPosition(new Point(0, 4));
  run('PutAfter');
  assert.equal(editor.getText(), 'abcdebc\nfghijgh\nklmnolm\npqrst\n');
});

test('blockwise P pastes the block before the cursor column', () => {
  const { editor, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('Yank');
  editor.setCursorBufferPosition(new Point(0, 0));
  run('PutBefore');
  assert.equal(editor.getText(), 'bcabcde\nghfghij\nlmklmno\npqrst\n');
});

test('blockwise paste pads short rows and appends past end-of-buffer', () => {
  const { editor, at, block, run } = setup(GRID);
  at(0, 1);
  block();
  run('Yank');
  editor.setCursorBufferPosition(new Point(3, 4)); // last line "pqrst"
  run('PutAfter');
  assert.equal(editor.getText(), 'abcde\nfghij\nklmno\npqrstbc\n     gh\n     lm');
});
