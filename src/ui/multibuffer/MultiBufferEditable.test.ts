/*
 * Editable project-search multibuffer — SURFACE proof (3d / G6,
 * tasks/code-editing/multibuffer.md). A `MultiBufferView({ editable: true })` backs each
 * source with a live `Document` from the registry, so editing a result row writes through to
 * the file's model (visible to any open tab, persisted by save), block (header) rows reject
 * edits, undo routes through the coordinating `ProjectionView`, and a row-count-changing edit
 * re-segments analytically. Complements ProjectionView.test.ts (the substrate) by exercising
 * the full editor funnel (vim → setTextInBufferRange → write-through) over real files.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { plugins, registerBuiltinPlugins } from '../../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from '../../syntax/grammar.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { MultiBufferView } from './MultiBufferView.ts';
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';

Gtk.init();
quilx.lsp.configure({ enable: false }); // no language servers spawned in the headless test

let hasJs = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.ts') ?? '');
});

let tmpSeq = 0;
function tmpFile(name: string, content: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-mbedit-${tmpSeq++}-`));
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

/** Whether view (row, col) carries the search-highlight decoration tag. */
function hasSearchTag(mbv: MultiBufferView, row: number, col: number): boolean {
  const buffer = (mbv.editor.sourceView as any).getBuffer();
  const tag = buffer.getTagTable().lookup('deco:search:highlight');
  if (!tag) return false;
  return asIter(buffer.getIterAtLineOffset(row, col)).hasTag(tag);
}

/** Two files, each shown as one full excerpt. Headers are WIDGETS (not buffer rows), so the
 *  buffer holds only source rows. View layout:
 *  0:alpha 1:beta 2:gamma 3:one 4:two 5:three */
function setup() {
  const a = tmpFile('a.ts', 'alpha\nbeta\ngamma\n');
  const b = tmpFile('b.ts', 'one\ntwo\nthree\n');
  const registry = new DocumentRegistry();
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [
      { path: a, regions: [{ startRow: 0, endRow: 2 }] },
      { path: b, regions: [{ startRow: 0, endRow: 2 }] },
    ],
  });
  const lines = () => mbv.editor.getText().split('\n');
  const edit = (row: number, col: number, text: string, endRow = row, endCol = col) =>
    mbv.editor.model.setTextInBufferRange(new Range(new Point(row, col), new Point(endRow, endCol)), text);
  return { a, b, registry, mbv, lines, edit };
}

test('editable search: opens with the caret at the top (not the materialized end)', () => {
  const { mbv } = setup();
  assert.deepEqual(mbv.editor.model.getCursorBufferPosition().toArray(), [0, 0]);
  mbv.dispose();
});

test('headers are widgets, not buffer text (the filename never appears as a buffer row)', () => {
  const { lines, mbv } = setup();
  assert.deepEqual(lines(), ['alpha', 'beta', 'gamma', 'one', 'two', 'three'], 'only source rows reach the buffer');
  assert.ok(!lines().some((l) => l.includes('.ts')), 'no filename header row in the buffer text');
  mbv.dispose();
});

test('search match: the hit span is highlighted at its mapped view position', () => {
  const a = tmpFile('hit.ts', 'const foo = 1;\nbar\n'); // "foo" at source row 0, cols 6..9
  const registry = new DocumentRegistry();
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }], matches: [{ row: 0, startCol: 6, endCol: 9 }] }],
  });
  // view (widget header): 0:'const foo = 1;' 1:'bar' — source row 0 → view row 0, cols pass through
  assert.equal(hasSearchTag(mbv, 0, 6), true, 'first char of the match highlighted');
  assert.equal(hasSearchTag(mbv, 0, 8), true, 'inside the match highlighted');
  assert.equal(hasSearchTag(mbv, 0, 5), false, 'the space before the match is not highlighted');
  assert.equal(hasSearchTag(mbv, 0, 9), false, 'end column is exclusive');
  mbv.dispose();
});

test('editable search: a file opened only by the search gets its grammar parsed (highlighting)', () => {
  if (!hasJs) return; // grammars not vendored in this environment
  const { a, b, registry, mbv } = setup(); // neither file was open before the search
  assert.equal(registry.find(a)!.syntax.hasTree, true, 'a.ts parsed even though no tab opened it');
  assert.equal(registry.find(b)!.syntax.hasTree, true, 'b.ts parsed even though no tab opened it');
  mbv.dispose();
});

test('editable search: an in-place edit writes through to the live Document', () => {
  const { a, b, registry, mbv, lines, edit } = setup();
  edit(1, 0, 'X'); // view row 1 = "beta" (a.ts source row 1)
  assert.equal(registry.find(a)!.getText(), 'alpha\nXbeta\ngamma\n', 'wrote through to a.ts model');
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nthree\n', 'b.ts untouched');
  assert.equal(lines()[1], 'Xbeta', 'and shows in the multibuffer view');
  mbv.dispose();
});

test('editable search: edits on a synthesized (block) row are rejected', () => {
  // Headers are widgets now, so the remaining block row is the `⋯` gap between two regions.
  const a = tmpFile('big.ts', 'r0\nr1\nr2\nr3\nr4\nr5\nr6\n');
  const registry = new DocumentRegistry();
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }, { startRow: 5, endRow: 6 }] }],
  });
  const lines = () => mbv.editor.getText().split('\n');
  // view: 0:r0 1:r1 2:⋯(gap) 3:r5 4:r6
  assert.deepEqual(lines(), ['r0', 'r1', '⋯', 'r5', 'r6']);
  mbv.editor.model.setTextInBufferRange(new Range(new Point(2, 0), new Point(2, 0)), 'Z'); // the gap row
  assert.equal(registry.find(a)!.getText(), 'r0\nr1\nr2\nr3\nr4\nr5\nr6\n', 'file untouched (edit rejected)');
  assert.deepEqual(lines(), ['r0', 'r1', '⋯', 'r5', 'r6'], 'gap row unchanged');
  mbv.dispose();
});

test('editable search: undo routes through the coordinating ProjectionView', () => {
  const { a, registry, mbv, edit } = setup();
  edit(0, 0, 'AA'); // view row 0 = "alpha" → "AAalpha"
  assert.equal(registry.find(a)!.getText(), 'AAalpha\nbeta\ngamma\n');
  mbv.editor.model.undo();
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\ngamma\n', 'undo reverted the source');
  mbv.dispose();
});

test('editable search: a multi-line edit re-segments; later rows still map correctly', () => {
  const { a, b, registry, mbv, lines, edit } = setup();
  edit(1, 4, '\nINSERTED'); // append a line after "beta" (a.ts source row 1)
  assert.equal(registry.find(a)!.getText(), 'alpha\nbeta\nINSERTED\ngamma\n', 'source grew by a row');
  assert.deepEqual(
    lines(),
    ['alpha', 'beta', 'INSERTED', 'gamma', 'one', 'two', 'three'],
    'the excerpt grew in place; b.ts excerpt shifted down intact',
  );
  // A subsequent in-place edit on a shifted row below routes to the right source (map rebuilt).
  edit(6, 0, 'Q'); // view row 6 = "three" (b.ts source row 2)
  assert.equal(registry.find(b)!.getText(), 'one\ntwo\nQthree\n', 'edit after the re-segment routed to b.ts');
  mbv.dispose();
});

test('editable search: save() persists every edited file to disk', () => {
  const { a, b, mbv, edit } = setup();
  edit(0, 0, 'A1'); // edit a.ts (view row 0 = "alpha")
  edit(3, 0, 'B1'); // edit b.ts (view row 3 = "one")
  assert.equal(mbv.isModified(), true);
  mbv.save();
  assert.equal(Fs.readFileSync(a, 'utf8'), 'A1alpha\nbeta\ngamma\n', 'a.ts written');
  assert.equal(Fs.readFileSync(b, 'utf8'), 'B1one\ntwo\nthree\n', 'b.ts written');
  assert.equal(mbv.isModified(), false, 'clean after save');
  mbv.dispose();
});

test('editable search: two regions of one file — a multi-line edit in the first shifts the second', () => {
  const a = tmpFile('big.ts', 'r0\nr1\nr2\nr3\nr4\nr5\nr6\nr7\n'); // rows 0..8 (row 8 empty)
  const registry = new DocumentRegistry();
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }, { startRow: 5, endRow: 6 }] }],
  });
  // view (widget header): 0:r0 1:r1 2:⋯(gap) 3:r5 4:r6
  const lines = () => mbv.editor.getText().split('\n');
  assert.deepEqual(lines(), ['r0', 'r1', '⋯', 'r5', 'r6']);
  // Insert a line in the FIRST region (after r0) — the second region must keep showing r5,r6.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 2), new Point(0, 2)), '\nNEW');
  assert.equal(registry.find(a)!.getText(), 'r0\nNEW\nr1\nr2\nr3\nr4\nr5\nr6\nr7\n', 'source grew');
  assert.deepEqual(lines(), ['r0', 'NEW', 'r1', '⋯', 'r5', 'r6'], 'second region still shows r5,r6');
  // And editing the second region routes to the correct (unshifted-in-source) rows.
  mbv.editor.model.setTextInBufferRange(new Range(new Point(5, 0), new Point(5, 0)), 'Z'); // view row 5 = r6
  assert.equal(registry.find(a)!.getText(), 'r0\nNEW\nr1\nr2\nr3\nr4\nr5\nZr6\nr7\n', 'second-region edit hit r6');
  mbv.dispose();
});

test('editable search: replace-all across files is one undo step (G6)', () => {
  const a = tmpFile('a.ts', 'x foo y\n');
  const b = tmpFile('b.ts', 'foo bar\n');
  const registry = new DocumentRegistry();
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [
      { path: a, regions: [{ startRow: 0, endRow: 0 }] },
      { path: b, regions: [{ startRow: 0, endRow: 0 }] },
    ],
  });
  // The same path SearchController.replaceAll drives: one transact over the whole scan, so the
  // write-throughs to BOTH files coalesce into one ProjectionView transaction.
  let count = 0;
  mbv.editor.model.scan(/foo/g, ({ replace }) => {
    replace('BAR');
    count++;
  });
  assert.equal(count, 2, 'matched both files');
  assert.equal(registry.find(a)!.getText(), 'x BAR y\n', 'a.ts replaced');
  assert.equal(registry.find(b)!.getText(), 'BAR bar\n', 'b.ts replaced');
  mbv.editor.model.undo(); // ONE undo
  assert.equal(registry.find(a)!.getText(), 'x foo y\n', 'a.ts reverted by the single undo');
  assert.equal(registry.find(b)!.getText(), 'foo bar\n', 'b.ts reverted by the single undo (one cross-file step)');
  mbv.dispose();
});

test('editable search: a file already open in the registry is shared (edit reaches that Document)', () => {
  const a = tmpFile('a.ts', 'alpha\nbeta\ngamma\n');
  const registry = new DocumentRegistry();
  const { document } = registry.acquire(a); // a "tab" opened it first
  document.loadFile(a);
  const mbv = new MultiBufferView({
    editable: true,
    documents: registry,
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 2 }] }],
  });
  // view (widget header): 0:alpha 1:beta 2:gamma — edit "alpha"
  mbv.editor.model.setTextInBufferRange(new Range(new Point(0, 0), new Point(0, 0)), 'SHARED ');
  assert.equal(document.getText(), 'SHARED alpha\nbeta\ngamma\n', 'the edit reached the already-open Document');
  mbv.dispose();
  registry.release(document); // drop the "tab"'s ref
});
