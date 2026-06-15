import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { applyTextEdits, normalizeWorkspaceEdit } from './workspaceEdit.ts';

const edit = (sl: number, sc: number, el: number, ec: number, newText: string): TextEdit => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});

test('applyTextEdits: insert, replace, delete on one line', () => {
  assert.equal(applyTextEdits('hello', [edit(0, 5, 0, 5, '!')]), 'hello!'); // insert at end
  assert.equal(applyTextEdits('hello', [edit(0, 0, 0, 1, 'H')]), 'Hello'); // replace
  assert.equal(applyTextEdits('hello', [edit(0, 1, 0, 3, '')]), 'hlo'); // delete "el"
});

test('applyTextEdits: multiple edits apply correctly regardless of input order', () => {
  // Replace "a" → "A" (0,0) and "c" → "C" (0,2) in "abc"; order shouldn't matter.
  const forward = applyTextEdits('abc', [edit(0, 0, 0, 1, 'A'), edit(0, 2, 0, 3, 'C')]);
  const reverse = applyTextEdits('abc', [edit(0, 2, 0, 3, 'C'), edit(0, 0, 0, 1, 'A')]);
  assert.equal(forward, 'AbC');
  assert.equal(reverse, 'AbC');
});

test('applyTextEdits: spans multiple lines (auto-import style insertion)', () => {
  const text = "import { a } from 'x';\nconst y = 1;\n";
  // Insert a new import line at the top.
  assert.equal(
    applyTextEdits(text, [edit(0, 0, 0, 0, "import { b } from 'y';\n")]),
    "import { b } from 'y';\nimport { a } from 'x';\nconst y = 1;\n",
  );
  // Replace across lines.
  assert.equal(applyTextEdits('a\nb\nc', [edit(0, 1, 2, 0, 'X')]), 'aXc');
});

test('applyTextEdits: character offsets honor the encoding', () => {
  const text = 'a\u{1F600}b'; // a😀b — emoji is 2 utf-16 units / 4 utf-8 bytes / 1 codepoint
  // Replace the char after the emoji ("b"): utf-16 char 3, utf-8 char 5, utf-32 char 2.
  assert.equal(applyTextEdits(text, [edit(0, 3, 0, 4, 'B')], 'utf-16'), 'a\u{1F600}B');
  assert.equal(applyTextEdits(text, [edit(0, 5, 0, 6, 'B')], 'utf-8'), 'a\u{1F600}B');
  assert.equal(applyTextEdits(text, [edit(0, 2, 0, 3, 'B')], 'utf-32'), 'a\u{1F600}B');
});

test('normalizeWorkspaceEdit: the changes map', () => {
  const we: WorkspaceEdit = { changes: { 'file:///a.ts': [edit(0, 0, 0, 1, 'X')] } };
  const { files, resourceOps } = normalizeWorkspaceEdit(we);
  assert.equal(resourceOps, 0);
  assert.deepEqual(files.map((f) => f.uri), ['file:///a.ts']);
  assert.equal(files[0].edits.length, 1);
});

test('normalizeWorkspaceEdit: documentChanges, counting resource ops separately', () => {
  const we: WorkspaceEdit = {
    documentChanges: [
      { textDocument: { uri: 'file:///a.ts', version: 1 }, edits: [edit(0, 0, 0, 0, 'x')] },
      { kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///b.ts' } as never,
    ],
  };
  const { files, resourceOps } = normalizeWorkspaceEdit(we);
  assert.deepEqual(files.map((f) => f.uri), ['file:///a.ts']);
  assert.equal(resourceOps, 1); // the rename is surfaced, not applied as a text edit
});
