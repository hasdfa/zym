import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Range } from '../../../text/Range.ts';
import { replaceTextInRangeViaDiff } from './utils.ts';

Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('replaceTextInRangeViaDiff applies the char-diff to reach the new text', () => {
  const m = model('hello world\n');
  replaceTextInRangeViaDiff(m, new Range([0, 0], [0, 11]), 'hella warld');
  assert.equal(m.getText(), 'hella warld\n');
});

test('replaceTextInRangeViaDiff handles insertions and deletions as one undo step', () => {
  const m = model('abcdef\n');
  replaceTextInRangeViaDiff(m, new Range([0, 0], [0, 6]), 'aXcdEf'); // insert X, change e→E
  assert.equal(m.getText(), 'aXcdEf\n');
  m.undo();
  assert.equal(m.getText(), 'abcdef\n'); // the diff edits coalesce into one undo
});
