/*
 * Multibuffer Phase 1a integration: prove the excerpt coordinate map + the multi-source
 * syntax projector together paint each excerpt from ITS OWN grammar at the right (translated)
 * view rows. This is the place a stitched-coordinate or shared-parse bug surfaces in
 * isolation (per tasks/code-editing/multibuffer.md). Grammars come from bundled plugins;
 * gated if not vendored.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk, GtkSource } from '../../gi.ts';
import { plugins, registerBuiltinPlugins } from '../../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from '../../syntax/grammar.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { MultiBufferProjection, type Excerpt, type Segment } from './MultiBufferModel.ts';
import { MultiBufferSyntax } from './MultiBufferSyntax.ts';
import { MultiBufferView } from './MultiBufferView.ts';

Gtk.init();

let hasJs = false;
let hasJson = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.ts') ?? '');
  hasJson = !!getGrammar(langIdForPath('/x.json') ?? '');
});

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const seg = (sourceKey: string, startRow: number, endRow: number): Segment =>
  ({ sourceKey, startRow, endRow, editable: false, kind: 'real' });

/** A parsed source over a bare buffer (the read-only-snapshot shape MultiBufferView uses). */
function source(text: string, path: string): DocumentSyntax {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const ds = new DocumentSyntax(buffer);
  ds.setLanguageForPath(path);
  return ds;
}

/** Whether `token` on view row `viewRow` carries `tagName` (checked mid-token). */
function tokenHasTag(buffer: any, viewRow: number, token: string, tagName: string): boolean {
  const tag = buffer.getTagTable().lookup(tagName);
  if (!tag) return false;
  const start = asIter(buffer.getIterAtLine(viewRow));
  const end = start.copy();
  if (!end.endsLine()) end.forwardToLineEnd();
  const lineText = buffer.getText(start, end, true) as string;
  const col = lineText.indexOf(token);
  if (col < 0) return false;
  return asIter(buffer.getIterAtLineOffset(viewRow, col + 1)).hasTag(tag);
}

test('projector paints each excerpt at its translated view rows from its own parse', () => {
  if (!hasJs) return;
  const a = source('// a\nconst aaa = 1;\nfunction fa() {}\n', '/a.ts');
  const b = source('const bbb = 2;\nlet ccc = 3;\n', '/b.ts');
  const lines: Record<string, string[]> = {
    '/a.ts': ['// a', 'const aaa = 1;', 'function fa() {}', ''],
    '/b.ts': ['const bbb = 2;', 'let ccc = 3;', ''],
  };
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('/a.ts', 1, 2)] }, // skip the leading comment
    { header: 'b.ts', segments: [seg('/b.ts', 0, 1)] },
  ];
  const projection = MultiBufferProjection.build(excerpts, (s) => lines[s.sourceKey].slice(s.startRow, s.endRow + 1));
  // 0:a.ts 1:const aaa 2:function fa 3:<blank> 4:b.ts 5:const bbb 6:let ccc
  assert.equal(projection.text, 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;\n');

  const buffer = new GtkSource.Buffer();
  buffer.setText(projection.text, -1);
  const view = new GtkSource.View({ buffer });
  const projector = new MultiBufferSyntax(view, buffer);
  projector.paint(projection, new Map([['/a.ts', a], ['/b.ts', b]]));

  assert.ok(tokenHasTag(buffer, 1, 'const', 'ts:keyword'), 'A: const highlighted (source row 1 → view row 1)');
  assert.ok(tokenHasTag(buffer, 2, 'function', 'ts:keyword'), 'A: function (source row 2 → view row 2)');
  // The B excerpt's source rows 0,1 are translated to view rows 5,6 — the coordinate map at work.
  assert.ok(tokenHasTag(buffer, 5, 'const', 'ts:keyword'), 'B: const (source row 0 → view row 5)');
  assert.ok(tokenHasTag(buffer, 6, 'let', 'ts:keyword'), 'B: let (source row 1 → view row 6)');
  assert.ok(tokenHasTag(buffer, 0, 'a.ts', 'mb:header'), 'header row 0 styled');
  assert.ok(tokenHasTag(buffer, 4, 'b.ts', 'mb:header'), 'header row 4 styled');
  // The blank separator (row 3) carries no header/keyword styling.
  assert.ok(!tokenHasTag(buffer, 3, '', 'mb:header'));
  a.dispose();
  b.dispose();
});

test('each excerpt uses its own grammar (ts keyword vs json string)', () => {
  if (!hasJs || !hasJson) return;
  const ts = source('const x = 1;\n', '/a.ts');
  const json = source('{ "const": 1 }\n', '/b.json');
  const lines: Record<string, string[]> = { '/a.ts': ['const x = 1;', ''], '/b.json': ['{ "const": 1 }', ''] };
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('/a.ts', 0, 0)] },
    { header: 'b.json', segments: [seg('/b.json', 0, 0)] },
  ];
  const projection = MultiBufferProjection.build(excerpts, (s) => lines[s.sourceKey].slice(s.startRow, s.endRow + 1));
  const buffer = new GtkSource.Buffer();
  buffer.setText(projection.text, -1);
  const view = new GtkSource.View({ buffer });
  new MultiBufferSyntax(view, buffer).paint(projection, new Map([['/a.ts', ts], ['/b.json', json]]));
  // 0:a.ts 1:const x = 1; 2:<blank> 3:b.json 4:{ "const": 1 }
  assert.ok(tokenHasTag(buffer, 1, 'const', 'ts:keyword'), 'ts `const` is a keyword');
  assert.ok(!tokenHasTag(buffer, 4, 'const', 'ts:keyword'), 'json `"const"` is NOT a ts keyword — own grammar');
  ts.dispose();
  json.dispose();
});

test('MultiBufferView assembles from disk, projects the right rows, and disposes', () => {
  if (!hasJs) return;
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-mb-'));
  const file = Path.join(dir, 'a.ts');
  Fs.writeFileSync(file, 'const a = 1;\nfunction f() {}\nconst b = 2;\n');
  let activated: { path: string; row: number } | null = null;
  const mb = new MultiBufferView({
    excerpts: [{ path: file, regions: [{ startRow: 0, endRow: 1 }] }],
    cwd: dir,
    onActivate: (loc) => { activated = loc; },
  });
  const buffer = (mb as any).buffer as any;
  const text = buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true);
  assert.ok(text.includes('a.ts'), 'relative header label present');
  assert.ok(text.includes('const a = 1;') && text.includes('function f() {}'), 'the excerpt rows are present');
  assert.ok(!text.includes('const b = 2;'), 'source row 2 is outside the excerpt');
  // The projection maps view row 1 (first body row) back to source row 0.
  (mb as any).activateRow(1);
  assert.deepEqual(activated, { path: file, row: 0 }, 'activating a body row resolves to its source location');
  (mb as any).activateRow(0);
  assert.deepEqual(activated, { path: file, row: 0 }, 'activating the header row is a no-op (keeps the last)');
  mb.dispose();
  Fs.rmSync(dir, { recursive: true, force: true });
});
