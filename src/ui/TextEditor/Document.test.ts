import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../../gi.ts';
import { Document } from './Document.ts';

// Document owns headless GtkSource buffers + per-view mirrors, so these need GTK.
Gtk.init();

const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const insertAt = (buf: any, off: number, text: string) => buf.insert(asIter(buf.getIterAtOffset(off)), text, -1);
const deleteRange = (buf: any, a: number, b: number) =>
  buf.delete(asIter(buf.getIterAtOffset(a)), asIter(buf.getIterAtOffset(b)));
const textOf = (buf: any): string => buf.getText(buf.getStartIter(), buf.getEndIter(), true);

function setup(text: string) {
  const doc = new Document();
  doc.setText(text);
  const a = doc.createView();
  const b = doc.createView();
  const synced = () => textOf(a) === doc.getText() && textOf(b) === doc.getText();
  return { doc, a, b, synced };
}

test('a new view is seeded with the current document text', () => {
  const { doc, a, b } = setup('hello\nworld\n');
  assert.equal(textOf(a), 'hello\nworld\n');
  assert.equal(textOf(b), 'hello\nworld\n');
  assert.equal(doc.getText(), 'hello\nworld\n');
});

test('a native edit in one view propagates to the model and the other views', () => {
  const { doc, a, b, synced } = setup('abc\n');
  insertAt(a, 0, 'X'); // like typing in view A
  assert.ok(synced(), 'all buffers equal after insert in A');
  assert.ok(textOf(b).startsWith('X'), 'B mirrored A');

  insertAt(b, 4, 'YY'); // type in view B
  assert.ok(synced(), 'all buffers equal after insert in B');

  deleteRange(a, 0, 1); // delete the X in view A
  assert.ok(synced(), 'all buffers equal after delete in A');
  assert.ok(!doc.getText().includes('X'), 'X removed everywhere');
});

test('undo/redo run on the model and propagate to every view', () => {
  const { doc, a, b, synced } = setup('abc\n');
  insertAt(a, 0, 'Z');
  const afterEdit = doc.getText();
  doc.undo();
  assert.ok(synced(), 'synced after undo');
  assert.ok(!doc.getText().includes('Z'), 'undo reverted the insert in all views');
  doc.redo();
  assert.ok(synced(), 'synced after redo');
  assert.equal(doc.getText(), afterEdit, 'redo re-applied');
});

test('setText re-syncs every view and clears modified', () => {
  const { doc, a, b } = setup('one\n');
  insertAt(a, 0, 'x');
  assert.ok(doc.isModified(), 'edits set modified');
  doc.setText('brand new\ncontent\n');
  assert.equal(textOf(a), 'brand new\ncontent\n');
  assert.equal(textOf(b), 'brand new\ncontent\n');
  assert.equal(doc.isModified(), false, 'setText clears modified');
});

test('removed views stop receiving edits', () => {
  const { doc, a, b } = setup('hi\n');
  doc.removeView(b);
  insertAt(a, 0, 'Q');
  assert.equal(doc.getText(), 'Qhi\n');
  assert.equal(textOf(a), 'Qhi\n');
  assert.equal(textOf(b), 'hi\n', 'detached view no longer mirrors');
});

test('500 deterministic-random cross-view edits never desync', () => {
  const { doc, a, b, synced } = setup('the quick brown fox\n');
  let ok = true;
  for (let i = 0; i < 500 && ok; i++) {
    const buf = i % 2 === 0 ? a : b;
    const len = textOf(buf).length;
    const off = (i * 7919) % Math.max(1, len);
    if (i % 3 === 0 && len > 4) {
      const s = Math.min(off, len - 2);
      deleteRange(buf, s, s + 1);
    } else {
      insertAt(buf, Math.min(off, len), String.fromCharCode(97 + (i % 26)));
    }
    ok = synced();
  }
  assert.ok(ok, 'stayed in sync across 500 random edits');
});
