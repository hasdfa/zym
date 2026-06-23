/*
 * Tests for indentLevelAt against a real TypeScript parse (web-tree-sitter), using
 * the TS-family fold-block node types as indent units.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import { indentLevelAt, enclosingTypeMatches, enclosingNodeRange } from './indent.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter');
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const tsWasm = require_.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');

const FOLD = new Set([
  'statement_block', 'object', 'array', 'class_body', 'switch_body',
  'named_imports', 'arguments', 'interface_body', 'enum_body', 'object_type',
]);

test('indent level = enclosing block depth; openers/closers sit at the outer level', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);

  const src = [
    'function f() {', // 0
    '  if (x) {',     // 1
    '    a;',          // 2
    '  }',             // 3
    '}',               // 4
    'const o = {',     // 5
    '  k: [',          // 6
    '    1,',          // 7
    '  ],',            // 8
    '};',              // 9
  ].join('\n');
  const tree = parser.parse(src);
  const root = tree.rootNode;
  const level = (row: number) => indentLevelAt(root, row, FOLD);

  assert.equal(level(0), 0, 'function opener');
  assert.equal(level(1), 1, 'if opener inside the function body');
  assert.equal(level(2), 2, 'statement inside both blocks');
  assert.equal(level(3), 1, 'closing } of the if aligns at the function-body level');
  assert.equal(level(4), 0, 'closing } of the function');
  assert.equal(level(5), 0, 'object opener');
  assert.equal(level(6), 1, 'array opener inside the object');
  assert.equal(level(7), 2, 'element inside object + array');
  assert.equal(level(8), 1, 'closing ] inside the object');
  assert.equal(level(9), 0, 'closing } of the object');
});

test('enclosingTypeMatches detects strings, comments, and regex (not plain code)', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  const re = /string|comment|char|regex/;
  // columns:        0123456789...
  const src = 'const s = "a(b)c"; // x(y)z\nconst r = /a(b)/;';
  const tree = parser.parse(src);
  const root = tree.rootNode;
  const inSC = (row: number, col: number) => enclosingTypeMatches(root, row, col, re);

  assert.equal(inSC(0, 12), true, '( inside the string literal');
  assert.equal(inSC(0, 22), true, '( inside the line comment');
  assert.equal(inSC(0, 0), false, 'the `const` keyword is plain code');
  assert.equal(inSC(0, 6), false, 'the identifier `s` is plain code');
  assert.equal(inSC(1, 12), true, '( inside the regex literal');
});

test('enclosingNodeRange finds the class def (outer) and its body (inner)', async () => {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  const isClass = (t: string) => /class|interface|enum/.test(t) && !/_body$/.test(t);

  const src = [
    'class Foo {',  // 0
    '  a = 1;',      // 1
    '  b() {}',      // 2
    '}',             // 3
    'const z = 9;',  // 4
  ].join('\n');
  const root = parser.parse(src).rootNode;

  const r = enclosingNodeRange(root, 2, 4, isClass); // cursor in `b() {}`
  assert.ok(r, 'finds the enclosing class');
  assert.deepEqual(r!.outer, { startRow: 0, endRow: 3 }, 'ac → whole class');
  assert.deepEqual(r!.inner, { startRow: 1, endRow: 2 }, 'ic → class body members');

  assert.equal(enclosingNodeRange(root, 4, 0, isClass), null, 'no class encloses line 4');
});
