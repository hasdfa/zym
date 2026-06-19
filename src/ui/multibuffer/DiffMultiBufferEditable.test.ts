/*
 * Editable diff multibuffer — SURFACE proof (Phase 3b / G5, tasks/code-editing/multibuffer.md).
 * `DiffMultiBufferView({ editable: true })` backs the NEW side with a live `Document`: editing a
 * context/added row writes through to the file's model, removed (phantom) rows reject edits, and
 * after the edit settles the diff is RE-COMPUTED and re-flowed via `ProjectionView.retarget` —
 * phantom rows appear/disappear with a minimal splice (no whole-buffer re-materialize). Pins the
 * model-level behavior; the rendering (no flash / caret-stable) is verified in the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { DiffMultiBufferView } from './DiffMultiBufferView.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
quilx.lsp.configure({ enable: false });

let tmpSeq = 0;
function tmpFile(content: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-diffedit-${tmpSeq++}-`));
  const p = Path.join(dir, 'f.ts');
  Fs.writeFileSync(p, content);
  return p;
}

const linesOf = (mbv: DiffMultiBufferView) => mbv.editor.getText().split('\n');
const flushReDiff = () => new Promise((r) => setTimeout(r, 200)); // > REDIFF_DEBOUNCE_MS

/** new (working/disk) differs from old (HEAD) at line 2: "line2" → "CHANGED". */
function setup() {
  const oldText = 'line1\nline2\nline3\n';
  const newText = 'line1\nCHANGED\nline3\n';
  const path = tmpFile(newText); // the live Document loads the NEW content from disk
  const registry = new DocumentRegistry();
  const mbv = new DiffMultiBufferView({ editable: true, documents: registry, files: [{ path, oldText, newText }] });
  return { path, registry, mbv };
}

test('editable diff: opens showing the removed (phantom) + added rows, caret at top', () => {
  const { mbv } = setup();
  // header, line1(ctx), line2(removed phantom), CHANGED(added), line3(ctx), ...
  const lines = linesOf(mbv);
  assert.ok(lines.includes('line2'), 'the removed line shows as a phantom row');
  assert.ok(lines.includes('CHANGED'), 'the added line shows');
  assert.deepEqual(mbv.editor.model.getCursorBufferPosition().toArray(), [0, 0]);
  mbv.dispose();
});

test('editable diff: editing the added row writes through to the live new-side Document', () => {
  const { path, registry, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  assert.ok(changedRow > 0, 'found the added row');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 0)), 'X');
  assert.equal(registry.find(path)!.getText(), 'line1\nXCHANGED\nline3\n', 'edit wrote through to the new-side model');
  mbv.dispose();
});

test('editable diff: editing a removed (phantom) row is rejected', () => {
  const { path, registry, mbv } = setup();
  const removedRow = linesOf(mbv).indexOf('line2'); // the phantom (old-side) removed line
  assert.ok(removedRow > 0, 'found the removed row');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(removedRow, 0), new Point(removedRow, 0)), 'Z');
  assert.equal(registry.find(path)!.getText(), 'line1\nCHANGED\nline3\n', 'new side unchanged (phantom edit rejected)');
  mbv.dispose();
});

test('editable diff: re-diff re-flows the view — making new == old removes the phantom row', async () => {
  const { path, registry, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  // Replace "CHANGED" with "line2" so the new side once again equals the base → no diff.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 7)), 'line2');
  assert.equal(registry.find(path)!.getText(), 'line1\nline2\nline3\n', 'new side now matches the base');
  await flushReDiff();
  const lines = linesOf(mbv);
  // With no remaining change, the windowed diff elides the whole file to a gap — the phantom
  // `line2` removed row and the `CHANGED` added row are both gone.
  assert.ok(!lines.includes('CHANGED'), 'the edited-away change no longer shows');
  assert.ok(lines.some((l) => l.includes('unchanged')), 're-diff re-flowed: the now-unchanged file is elided');
  mbv.dispose();
});

test('editable diff: save() persists the edited new-side file', () => {
  const { path, mbv } = setup();
  const changedRow = linesOf(mbv).indexOf('CHANGED');
  mbv.editor.model.setTextInBufferRange(new Range(new Point(changedRow, 0), new Point(changedRow, 0)), 'Y');
  assert.equal(mbv.isModified(), true);
  mbv.save();
  assert.equal(Fs.readFileSync(path, 'utf8'), 'line1\nYCHANGED\nline3\n', 'written to disk');
  assert.equal(mbv.isModified(), false, 'clean after save');
  mbv.dispose();
});
