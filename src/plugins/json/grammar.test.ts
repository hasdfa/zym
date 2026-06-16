/*
 * Integration test for the JSON plugin's grammar assets against the real binary
 * we ship: the bundled JSON wasm loads in the pinned web-tree-sitter, the
 * highlight/fold queries compile (catching node-name drift), and a small sample
 * highlights the captures we expect (keys, strings, numbers, literals, comments).
 *
 * Uses web-tree-sitter directly (not the registry) so it's hermetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;
const HERE = Path.dirname(fileURLToPath(import.meta.url));
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const query = (rel: string) => Fs.readFileSync(Path.join(HERE, 'queries', rel), 'utf8');

// Capture names produced for a parsed source, by running a highlights query.
function capturesFor(lang: any, scm: string, src: string): Set<string> {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(src);
  const names = new Set<string>();
  for (const m of lang.query(scm).matches(tree.rootNode)) {
    for (const c of m.captures) names.add(c.name);
  }
  return names;
}

test('bundled JSON grammar: loads, queries compile, highlights keys + values', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const json = await Parser.Language.load(require_.resolve('tree-sitter-wasms/out/tree-sitter-json.wasm'));

  // Highlight + fold queries compile against the grammar.
  assert.ok(json.query(query('json/highlights.scm')).captureNames.length > 0);
  assert.ok(json.query(query('json/folds.scm')).captureNames.includes('fold'));

  const src = [
    '// a comment',
    '{',
    '  "name": "quilx",',
    '  "count": 42,',
    '  "ok": true,',
    '  "nope": false,',
    '  "nada": null,',
    '  "list": [1, "two", { "x": "y\\n" }]',
    '}',
    '',
  ].join('\n');
  const caps = capturesFor(json, query('json/highlights.scm'), src);
  for (const expected of ['property', 'string', 'number', 'boolean', 'constant.builtin', 'comment', 'punctuation.bracket']) {
    assert.ok(caps.has(expected), `JSON should produce a @${expected} capture`);
  }
});
