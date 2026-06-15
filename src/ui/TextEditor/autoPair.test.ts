import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { Point } from '../../text/Point.ts';
import { handleAutoPairInsert, handleAutoPairBackspace } from './autoPair.ts';

Gtk.init();

function editor(text: string, col: number) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const e = new EditorModel(view, buffer);
  e.setCursorBufferPosition(new Point(0, col));
  return e;
}
const at = (e: EditorModel) => e.getCursorBufferPosition().column;

test('typing an opener inserts the closer and sits between', () => {
  const e = editor('', 0);
  assert.equal(handleAutoPairInsert(e, '('), true);
  assert.equal(e.getText(), '()');
  assert.equal(at(e), 1);
});

test('each bracket/quote pairs', () => {
  for (const [open, close] of [['[', ']'], ['{', '}'], ['"', '"'], ['`', '`']]) {
    const e = editor('', 0);
    handleAutoPairInsert(e, open);
    assert.equal(e.getText(), open + close);
  }
});

test('typing a closer over an existing one steps over it', () => {
  const e = editor('()', 1);
  assert.equal(handleAutoPairInsert(e, ')'), true);
  assert.equal(e.getText(), '()'); // no duplicate
  assert.equal(at(e), 2);
});

test('backspace inside an empty pair deletes both halves', () => {
  const e = editor('()', 1);
  assert.equal(handleAutoPairBackspace(e), true);
  assert.equal(e.getText(), '');
});

test('brackets do not wrap a following word', () => {
  const e = editor('foo', 0);
  assert.equal(handleAutoPairInsert(e, '('), false);
  assert.equal(e.getText(), 'foo'); // caller inserts the bare "("
});

test('quotes stay literal after a word (apostrophes) and at string ends', () => {
  assert.equal(handleAutoPairInsert(editor('dont', 4), "'"), false); // apostrophe
  assert.equal(handleAutoPairInsert(editor('"x', 2), '"'), false); // closing after a word
});

test('non-pair characters and plain backspace are not handled', () => {
  assert.equal(handleAutoPairInsert(editor('', 0), 'a'), false);
  assert.equal(handleAutoPairBackspace(editor('ab', 1)), false);
});
