/*
 * Buffer-only TextEditor — the file-less embedded-input mode (commit message, diff panes, the
 * location picker). After the G1 merge (TextEditor backed by a `TextEditorSource`), buffer-only
 * mode is a file-less `Document` + the `BufferEditorOptions` presentation knobs — no LSP, no line
 * numbers, no file I/O — and must keep the full editing experience. This pins that contract so the
 * merge (and future changes to the source seam) can't regress it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { TextEditor, createInput } from './TextEditor.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
quilx.lsp.configure({ enable: false });

test('buffer-only: initialText is the text; edits write through; no backing file', () => {
  const editor = new TextEditor({ buffer: { initialText: 'hello\nworld' } });
  assert.equal(editor.getText(), 'hello\nworld');
  assert.equal(editor.currentFile, null, 'a buffer-only editor has no file');

  editor.model.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 0)), 'X');
  assert.equal(editor.getText(), 'Xhello\nworld', 'the edit wrote through to the buffer');

  editor.setText('replaced');
  assert.equal(editor.getText(), 'replaced', 'setText replaces the whole buffer');
  editor.dispose();
});

test('buffer-only: read-only mode rejects edits but keeps the text', () => {
  const editor = new TextEditor({ buffer: { initialText: 'frozen', readOnly: true } });
  editor.model.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 0)), 'X');
  assert.equal(editor.getText(), 'frozen', 'a read-only buffer-only editor rejects edits');
  editor.dispose();
});

test('buffer-only: a placeholder shows over an empty buffer and hides once typed into', () => {
  const editor = new TextEditor({ buffer: { initialText: '', placeholder: 'Commit message…' } });
  const label = (editor as any).placeholderLabel as InstanceType<typeof Gtk.Label> | null;
  assert.ok(label, 'a placeholder label was built');
  assert.equal(label!.getVisible(), true, 'shown over the empty buffer');

  editor.setText('a commit');
  assert.equal(label!.getVisible(), false, 'hidden once the buffer has text');
  editor.dispose();
});

test('buffer-only: disposes cleanly (idempotent) with no file/LSP teardown', () => {
  const editor = new TextEditor({ buffer: { initialText: 'x' } });
  editor.dispose();
  editor.dispose(); // idempotent
  assert.ok(true);
});

test('softWrap: an embedded editor defaults to no wrap, but the option forces it on', () => {
  const off = new TextEditor({ buffer: { initialText: 'x' } });
  assert.equal((off as any).view.getWrapMode(), Gtk.WrapMode.NONE, 'embedded editors default off');
  off.dispose();

  const on = new TextEditor({ buffer: { initialText: 'x' }, softWrap: true });
  assert.equal((on as any).view.getWrapMode(), Gtk.WrapMode.WORD_CHAR, 'the softWrap option wins');
  on.dispose();
});

test('createInput: buffer-only, soft-wrapped, tagged with the quilx-input class', () => {
  const editor = createInput({ placeholder: 'Message…' });
  assert.equal(editor.currentFile, null, 'an input is buffer-only (no file)');
  const view = (editor as any).view as InstanceType<typeof Gtk.Widget>;
  assert.ok(view.hasCssClass('quilx-input'), 'tagged with the quilx-input class');
  assert.equal((editor as any).view.getWrapMode(), Gtk.WrapMode.WORD_CHAR, 'inputs soft-wrap by default');
  editor.dispose();
});

test('createInput: a custom cssClass joins quilx-input; softWrap can be turned off', () => {
  const editor = createInput({ cssClass: 'agent-prompt', softWrap: false });
  const view = (editor as any).view as InstanceType<typeof Gtk.Widget>;
  assert.ok(view.hasCssClass('quilx-input'), 'still carries the shared class');
  assert.ok(view.hasCssClass('agent-prompt'), 'plus the caller-specific class');
  assert.equal((editor as any).view.getWrapMode(), Gtk.WrapMode.NONE, 'softWrap:false opts back out');
  editor.dispose();
});
