/*
 * ProjectionView tests (Phase 2b/2c, tasks/code-editing/multibuffer.md). The IDENTITY case
 * (single full-file source) must reproduce Document's view↔model sync byte-for-byte — these
 * mirror Document.test.ts's sync contract, but through the new projection-backed materializer
 * (the substrate that Phase 2e swaps Document onto). Plus: multi-source materialization,
 * non-editable gating, and reverse-sync re-materialization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { ProjectionView } from './ProjectionView.ts';
import type { Item } from './ViewProjection.ts';
import { Point } from '../../text/Point.ts';

// ProjectionView owns GtkSource buffers, so this needs GTK.
Gtk.init();

const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const insertAt = (buf: any, off: number, text: string) => buf.insert(asIter(buf.getIterAtOffset(off)), text, -1);
const deleteRange = (buf: any, a: number, b: number) =>
  buf.delete(asIter(buf.getIterAtOffset(a)), asIter(buf.getIterAtOffset(b)));
const textOf = (buf: any): string => buf.getText(buf.getStartIter(), buf.getEndIter(), true);

function srcBuffer(text: string): SourceBuffer {
  const b = new GtkSource.Buffer();
  b.setText(text, -1);
  return b;
}
const fileItem = (key: string, lastRow: number): Item =>
  ({ type: 'segment', segment: { sourceKey: key, startRow: 0, endRow: lastRow, editable: true, kind: 'real' } });

function identitySetup(text: string) {
  const src = srcBuffer(text);
  const pv = new ProjectionView([fileItem('f', src.getLineCount() - 1)], new Map([['f', src]]));
  const synced = () => textOf(pv.buffer) === textOf(src);
  return { src, pv, synced };
}

// --- identity (single full-file source) = today's Document sync ---------------

test('materializes the view buffer from the source', () => {
  const { pv, src } = identitySetup('hello\nworld\n');
  assert.equal(textOf(pv.buffer), 'hello\nworld\n');
  assert.equal(textOf(src), 'hello\nworld\n');
  assert.equal(pv.view.isIdentity, true);
});

test('a view edit writes through to the source', () => {
  const { pv, src, synced } = identitySetup('abc\n');
  insertAt(pv.buffer, 0, 'X'); // like typing in the view
  assert.ok(synced(), 'view + source equal after a view insert');
  assert.equal(textOf(src), 'Xabc\n');

  deleteRange(pv.buffer, 0, 1); // delete the X
  assert.ok(synced());
  assert.equal(textOf(src), 'abc\n');
});

test('a source edit mirrors into the view (reverse-sync)', () => {
  const { pv, src, synced } = identitySetup('abc\n');
  insertAt(src, 0, 'Z'); // a change from elsewhere (another view / undo / reload)
  assert.ok(synced(), 'view mirrored the source insert');
  assert.equal(textOf(pv.buffer), 'Zabc\n');

  deleteRange(src, 0, 1);
  assert.ok(synced());
  assert.equal(textOf(pv.buffer), 'abc\n');
});

test('500 deterministic-random edits across both directions never desync', () => {
  const { pv, src, synced } = identitySetup('the quick brown fox\n');
  let ok = true;
  for (let i = 0; i < 500 && ok; i++) {
    const buf = i % 2 === 0 ? (pv.buffer as any) : (src as any); // alternate view / source origin
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
  assert.ok(ok, 'view + source stayed equal across 500 edits from both sides');
});

// --- multi-source -------------------------------------------------------------

function multiSetup() {
  const a = srcBuffer('// a\nconst aaa = 1;\nfunction fa() {}\n');
  const b = srcBuffer('const bbb = 2;\nlet ccc = 3;\n');
  // Editable segments so the gating distinction (block = readonly, segment = editable) is
  // meaningful; viewText / reverse-sync are unaffected by the flag.
  const items: Item[] = [
    { type: 'block', block: { kind: 'header', text: 'a.ts' } },
    { type: 'segment', segment: { sourceKey: 'a.ts', startRow: 1, endRow: 2, editable: true, kind: 'real' } },
    { type: 'block', block: { kind: 'blank', text: '' } },
    { type: 'block', block: { kind: 'header', text: 'b.ts' } },
    { type: 'segment', segment: { sourceKey: 'b.ts', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const pv = new ProjectionView(items, new Map([['a.ts', a], ['b.ts', b]]));
  return { a, b, pv };
}

test('materializes a multi-source projection with headers', () => {
  const { pv } = multiSetup();
  assert.equal(pv.view.isIdentity, false);
  assert.equal(textOf(pv.buffer), 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;');
});

test('non-editable rows (headers) carry the readonly tag; segment rows do not', () => {
  const { pv } = multiSetup();
  const tag = (pv.buffer as any).getTagTable().lookup('vp:readonly');
  assert.ok(tag, 'readonly tag exists');
  assert.equal(asIter((pv.buffer as any).getIterAtLineOffset(0, 1)).hasTag(tag), true, 'header row 0 is readonly');
  assert.equal(asIter((pv.buffer as any).getIterAtLineOffset(3, 0)).hasTag(tag), true, 'blank row 3 is readonly');
  assert.equal(asIter((pv.buffer as any).getIterAtLineOffset(1, 1)).hasTag(tag), false, 'segment row 1 is editable');
});

test('multi-source: an in-place edit routes to the right source, leaving others intact', () => {
  const { a, b, pv } = multiSetup();
  // View rows: 0:a.ts 1:"const aaa = 1;" 2:"function fa() {}" 3:<blank> 4:b.ts 5:"const bbb = 2;" 6:"let ccc = 3;"
  // Insert "export " at the start of view row 1 → source a.ts row 1.
  const row1Start = asIter((pv.buffer as any).getIterAtLine(1)).getOffset();
  insertAt(pv.buffer as any, row1Start, 'export ');
  assert.equal(textOf(a), '// a\nexport const aaa = 1;\nfunction fa() {}\n', 'wrote through to source a.ts');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'source b.ts untouched');
  // The view row matches the edited source row.
  const view = textOf(pv.buffer) as string;
  assert.equal(view.split('\n')[1], 'export const aaa = 1;');

  // A second in-place edit, into source b.ts (proves the row-direct map stayed valid).
  const row6Start = asIter((pv.buffer as any).getIterAtLine(6)).getOffset();
  insertAt(pv.buffer as any, row6Start, 'const ');
  assert.equal(textOf(b), 'const bbb = 2;\nconst let ccc = 3;\n', 'second edit routed to b.ts');
});

test('multi-source: an edit on a header row does not write through to any source', () => {
  const { a, b, pv } = multiSetup();
  insertAt(pv.buffer as any, 0, 'X'); // view row 0 is the "a.ts" header (a block)
  assert.equal(textOf(a), '// a\nconst aaa = 1;\nfunction fa() {}\n', 'a.ts unchanged');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'b.ts unchanged');
});

test('multi-source: a delete spanning two sources is rejected (boundary clamp)', () => {
  const { a, b, pv } = multiSetup();
  // Delete from inside a.ts's excerpt (view row 2) across the blank/header into b.ts (row 5).
  const from = asIter((pv.buffer as any).getIterAtLine(2)).getOffset();
  const to = asIter((pv.buffer as any).getIterAtLineOffset(5, 3)).getOffset();
  deleteRange(pv.buffer as any, from, to);
  assert.equal(textOf(a), '// a\nconst aaa = 1;\nfunction fa() {}\n', 'a.ts unchanged (cross-source delete rejected)');
  assert.equal(textOf(b), 'const bbb = 2;\nlet ccc = 3;\n', 'b.ts unchanged');
});

test('a source change re-materializes the multi-source view (reverse-sync rebuild)', async () => {
  const { a, pv } = multiSetup();
  // Change a projected row of source A (row 1 = "const aaa = 1;").
  const lineStart = asIter((a as any).getIterAtLine(1)).getOffset();
  insertAt(a as any, lineStart, 'export ');
  await Promise.resolve(); // flush the deferred rebuild microtask
  assert.equal(
    textOf(pv.buffer),
    'a.ts\nexport const aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;',
    'the view re-materialized with the edited source row',
  );
});

// --- multi-source in-place reverse-sync + cross-source undo (Phase 3a/3c) -----------------

function editableMulti() {
  const a = srcBuffer('a0\na1\n');
  const b = srcBuffer('b0\nb1\n');
  (a as any).setEnableUndo(true);
  (b as any).setEnableUndo(true);
  const items: Item[] = [
    { type: 'segment', segment: { sourceKey: 'a', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
    { type: 'segment', segment: { sourceKey: 'b', startRow: 0, endRow: 1, editable: true, kind: 'real' } },
  ];
  const pv = new ProjectionView(items, new Map([['a', a], ['b', b]]));
  return { a, b, pv }; // view rows: 0:a0 1:a1 2:b0 3:b1
}

test('multi-source: an external in-place source edit mirrors into the view', () => {
  const { a, pv } = editableMulti();
  insertAt(a as any, 0, 'X'); // a change to source a from elsewhere (not via the multibuffer)
  assert.equal(textOf(a), 'Xa0\na1\n');
  assert.equal(textOf(pv.buffer), 'Xa0\na1\nb0\nb1', 'the view mirrored the in-place edit at the right row');
});

test('cross-source undo: a view edit routes + undoes on the right source', () => {
  const { a, b, pv } = editableMulti();
  pv.beginUserAction();
  insertAt(pv.buffer as any, 0, 'X'); // view row 0 → source a
  pv.endUserAction();
  assert.equal(textOf(a), 'Xa0\na1\n', 'wrote through to source a');
  assert.equal(pv.canUndo(), true);

  pv.undo();
  assert.equal(textOf(a), 'a0\na1\n', 'undo reverted source a');
  assert.equal(textOf(pv.buffer), 'a0\na1\nb0\nb1', 'view reflects the undo');
  assert.equal(textOf(b), 'b0\nb1\n', 'source b untouched');

  pv.redo();
  assert.equal(textOf(a), 'Xa0\na1\n', 'redo re-applied');
});

test('cross-source undo: a multi-file transaction undoes both sources as one step', () => {
  const { a, b, pv } = editableMulti();
  pv.beginUserAction();
  insertAt(pv.buffer as any, 0, 'X'); // edits source a (view row 0)
  const b0Start = asIter((pv.buffer as any).getIterAtLine(2)).getOffset(); // view row 2 = b0
  insertAt(pv.buffer as any, b0Start, 'Y'); // edits source b (view row 2)
  pv.endUserAction();
  assert.equal(textOf(a), 'Xa0\na1\n');
  assert.equal(textOf(b), 'Yb0\nb1\n');

  pv.undo(); // ONE step reverts both files
  assert.equal(textOf(a), 'a0\na1\n');
  assert.equal(textOf(b), 'b0\nb1\n');
  assert.equal(pv.canUndo(), false, 'the multi-file edit was a single undo step');
});

test('dispose stops syncing', () => {
  const { pv, src } = identitySetup('abc\n');
  pv.dispose();
  insertAt(src as any, 0, 'Z');
  assert.equal(textOf(pv.buffer), 'abc\n', 'disposed view no longer mirrors the source');
});

// --- folds (the analytic transform, ported from Document.test.ts's fold contract) ---------
// Single source = the model. "Editing another view" = editing the source buffer directly
// (reverse-sync); "editing the folded view" = editing pv.buffer (write-through).

const SAMPLE = "import {\n  X,\n} from './git.ts';\n";
const FOLD = [8, 14] as const; // collapse `\n  X,\n` (after `{`, up to `}`)
const cpSlice = (s: string, a: number, b?: number): string => [...s].slice(a, b).join('');

test('fold collapses the view and leaves the source intact', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';\n", 'view collapsed to one line');
  assert.equal(textOf(src), SAMPLE, 'source untouched');
});

test('unfold restores the collapsed text exactly', () => {
  const { pv } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]');
  pv.unfold(fold!);
  assert.equal(textOf(pv.buffer), SAMPLE);
});

test('an edit before a fold (write-through) maps to the right source offset', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(pv.buffer as any, 0, 'Q');
  assert.equal(textOf(src), 'Q' + SAMPLE);
  assert.equal(textOf(pv.buffer), "Qimport {[...]} from './git.ts';\n");
});

test('an edit after a fold (write-through) maps past the collapsed body', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(pv.buffer as any, textOf(pv.buffer).length - 1, '!'); // just before the trailing newline
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';!\n");
  assert.equal(textOf(src), "import {\n  X,\n} from './git.ts';!\n");
});

test('an external source edit propagates into a folded view, kept collapsed', () => {
  const { pv, src } = identitySetup(SAMPLE);
  pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(src as any, 0, 'Z'); // a change from elsewhere, before the fold
  assert.equal(textOf(src), 'Z' + SAMPLE);
  assert.equal(textOf(pv.buffer), "Zimport {[...]} from './git.ts';\n");
});

test('an external edit inside the fold is absorbed; unfold restores it', () => {
  const { pv, src } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]');
  insertAt(src as any, 11, 'YY'); // inside the collapsed body (around the `X`)
  assert.equal(textOf(pv.buffer), "import {[...]} from './git.ts';\n", 'view stays collapsed (absorbed)');
  assert.equal(textOf(src), "import {\n  YYX,\n} from './git.ts';\n");
  pv.unfold(fold!);
  assert.equal(textOf(pv.buffer), textOf(src), 'unfold restores the grown body');
});

test('nested folds: an outer fold subsumes an inner one; model intact, unfold restores', () => {
  const { pv, src } = identitySetup('out {\n in {\n  x\n }\n}\n');
  const t = () => textOf(pv.buffer);
  pv.fold(t().indexOf('in {') + 4, t().indexOf('}'), '[3]'); // fold inner
  assert.equal(t(), 'out {\n in {[3]}\n}\n');
  const outer = pv.fold(t().indexOf('out {') + 5, t().lastIndexOf('}'), '[5]'); // fold outer (subsumes inner)
  assert.equal(t(), 'out {[5]}\n', 'outer collapses, subsuming the inner fold');
  assert.equal(textOf(src), 'out {\n in {\n  x\n }\n}\n', 'source never corrupted by nesting');
  insertAt(pv.buffer as any, 0, 'Z'); // edit before the nested fold still translates
  assert.equal(textOf(src), 'Zout {\n in {\n  x\n }\n}\n');
  pv.unfold(outer!);
  assert.equal(t(), 'Zout {\n in {\n  x\n }\n}\n', 'unfolding the outer restores the full body');
});

test('view↔source line + point translation across a fold', () => {
  const { pv } = identitySetup(SAMPLE);
  const fold = pv.fold(FOLD[0], FOLD[1], '[...]')!;
  // view line 0 = "import {[...]} from './git.ts';"; view line 1 (after the fold) = source line 3.
  assert.equal(pv.modelLineForViewLine(0), 0);
  assert.equal(pv.modelLineForViewLine(1), 3);
  assert.equal(pv.viewLineForModelLine(3), 1);
  // the `}` is at view column 13 on line 0, and is column 0 on source line 2.
  const mp = pv.modelPointFromView(new Point(0, 13));
  assert.equal(mp.row, 2);
  assert.equal(mp.column, 0);
  // round-trip a source point below the fold.
  const vp = pv.viewPointFromModel(new Point(3, 0));
  assert.deepEqual(pv.modelPointFromView(vp).toArray(), [3, 0]);
  // fold introspection
  assert.deepEqual(pv.foldPlaceholderRange(fold), [8, 13]);
  assert.equal(pv.foldModelText(fold), "\n  X,\n");
  assert.equal(pv.isFoldAlive(fold), true);
  pv.unfold(fold);
  assert.equal(pv.isFoldAlive(fold), false);
});

test('600 edits around a fold never desync the source or the collapsed view', () => {
  const base = 'the quick brown fox jumps over the lazy dog\n';
  const { pv, src } = identitySetup(base);
  const fold = pv.fold(4, 16, '[...]')!; // collapse "quick brown "
  const collapsed = () => cpSlice(textOf(src), 0, fold.start) + fold.placeholder + cpSlice(textOf(src), fold.end);
  let ok = true;
  let why = '';
  for (let i = 0; i < 600 && ok; i++) {
    if (i % 2 === 1) {
      insertAt(pv.buffer as any, 0, '.'); // write-through, before the fold
    } else {
      const len = textOf(src).length;
      if (i % 3 === 0 && len > fold.end + 3) {
        const at = fold.end + 1; // delete a char safely after the fold
        deleteRange(src as any, at, at + 1);
      } else {
        insertAt(src as any, len - 1, String.fromCharCode(97 + (i % 26))); // insert after the fold
      }
    }
    if (textOf(pv.buffer) !== collapsed()) { ok = false; why = `collapsed view desync @${i}`; }
  }
  assert.ok(ok, why || 'view stayed collapsed-consistent across 600 edits');
  pv.unfold(fold);
  assert.equal(textOf(pv.buffer), textOf(src), 'unfolds to the live source after the fuzz');
});
