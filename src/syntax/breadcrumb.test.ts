/*
 * Tests for breadcrumbAt against a real TypeScript parse (web-tree-sitter): the structural
 * scopes (class/function/method) enclosing a position, outermost first — and that control
 * flow (if/for) is excluded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import { breadcrumbAt } from './breadcrumb.ts';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter');
const wtsDir = Path.dirname(require_.resolve('web-tree-sitter'));
const tsWasm = require_.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');

async function parse(src: string) {
  await Parser.init({ locateFile: (n: string) => Path.join(wtsDir, n) });
  const lang = await Parser.Language.load(tsWasm);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser.parse(src).rootNode;
}

const names = (root: any, row: number, column: number) => breadcrumbAt(root, row, column).map((c) => c.name);

test('breadcrumb = enclosing class → method, outermost first', async () => {
  const src = [
    'class Foo {',   // 0
    '  bar() {',      // 1
    '    if (x) {',   // 2
    '      baz();',   // 3
    '    }',          // 4
    '  }',            // 5
    '}',              // 6
  ].join('\n');
  const root = await parse(src);

  // Inside the `if` body: structural-only excludes the `if`, so just class → method.
  assert.deepEqual(names(root, 3, 6), ['Foo', 'bar'], 'class → method (if excluded)');
  // On the method header, still inside the class + method.
  assert.deepEqual(names(root, 1, 2), ['Foo', 'bar']);

  // Each crumb carries the highlight capture so the bar can reuse the token color:
  // class → `type`, method → `function`.
  assert.deepEqual(
    breadcrumbAt(root, 3, 6).map((c) => c.capture),
    ['type', 'function'],
  );
});

test('breadcrumb is empty at top level', async () => {
  const src = 'const z = 9;\n';
  const root = await parse(src);
  assert.deepEqual(names(root, 0, 0), []);
});

test('breadcrumb names an arrow function bound to a const', async () => {
  const src = [
    'const handler = () => {', // 0
    '  return 1;',             // 1
    '};',                      // 2
  ].join('\n');
  const root = await parse(src);
  assert.deepEqual(names(root, 1, 4), ['handler'], 'arrow fn shows its binding name');
});

test('anonymous functions are skipped, not shown as "arrow function"', async () => {
  const src = [
    'function outer() {',  // 0
    '  items.forEach((x) => {', // 1
    '    use(x);',         // 2
    '  });',               // 3
    '}',                   // 4
  ].join('\n');
  const root = await parse(src);
  // Cursor inside the anonymous callback: only the named `outer` shows.
  assert.deepEqual(names(root, 2, 4), ['outer']);

  // A top-level anonymous arrow yields nothing (no humanized node type).
  const root2 = await parse('[].map(() => {\n  go();\n});\n');
  assert.deepEqual(names(root2, 1, 2), []);
});
