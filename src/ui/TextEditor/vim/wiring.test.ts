import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { zym } from '../../../zym.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import { attachVim } from './index.ts';

Gtk.init();

function makeEditor(text = 'hello\n'): { editor: EditorModel; view: InstanceType<typeof GtkSource.View> } {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return { editor: new EditorModel(view, buffer), view };
}

test('attachVim registers per-view commands that dispatch to its VimState', () => {
  const { editor, view } = makeEditor();
  const vimState = attachVim(editor);
  assert.equal(vimState.mode, 'normal');

  // Dispatch the command bound to this view instance — the keymap layer does the
  // same once a keystroke is matched.
  const dispatched = zym.commands.dispatch(view, 'vim-mode-plus:activate-insert-mode');
  assert.ok(dispatched);
  assert.equal(vimState.mode, 'insert');
  assert.equal(view.getEditable(), true);

  zym.commands.dispatch(view, 'vim-mode-plus:activate-normal-mode');
  assert.equal(vimState.mode, 'normal');
  assert.equal(view.getEditable(), false);
});

test('visual-block I/A are registered commands that column-insert', () => {
  const { editor, view } = makeEditor('abcde\nfghij\nklmno\n');
  const vimState = attachVim(editor);
  editor.setCursorBufferPosition(new Point(0, 1));
  vimState.operationStack.run('ActivateBlockwiseVisualMode');
  vimState.operationStack.run('MoveDown'); // block over rows 0-1, column 1
  // `I` in visual mode dispatches this command (registered for visual:I). Before
  // the fix it was unregistered, so `I` fell through to the normal-mode binding.
  assert.ok(zym.commands.dispatch(view, 'vim-mode-plus:insert-at-start-of-target'));
  assert.equal(vimState.mode, 'insert');
  editor.insertText('X');
  vimState.operationStack.run('ActivateNormalMode');
  assert.equal(editor.getText(), 'aXbcde\nfXghij\nklmno\n'); // inserted before the block on each row

  // `A` appends after the block on each row.
  editor.setCursorBufferPosition(new Point(0, 2));
  vimState.operationStack.run('ActivateBlockwiseVisualMode');
  vimState.operationStack.run('MoveDown');
  assert.ok(zym.commands.dispatch(view, 'vim-mode-plus:insert-at-end-of-target'));
  assert.equal(vimState.mode, 'insert');
  editor.insertText('Y');
  vimState.operationStack.run('ActivateNormalMode');
  assert.equal(editor.getText(), 'aXbYcde\nfXgYhij\nklmno\n');
});

test('commands are isolated per editor instance', () => {
  const a = makeEditor();
  const b = makeEditor();
  const vimA = attachVim(a.editor);
  const vimB = attachVim(b.editor);

  zym.commands.dispatch(a.view, 'vim-mode-plus:activate-insert-mode');
  assert.equal(vimA.mode, 'insert');
  assert.equal(vimB.mode, 'normal'); // editor B unaffected
});
