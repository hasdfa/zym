import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lspGlobToRegExp, watcherRegExp } from './glob.ts';

test('lspGlobToRegExp: ** spans path segments (including zero)', () => {
  const re = lspGlobToRegExp('**/*.ts');
  assert.ok(re.test('a.ts')); // zero dirs
  assert.ok(re.test('packages/utils/src/a.ts'));
  assert.ok(!re.test('a.js'));
  assert.ok(!re.test('a.tsx')); // *.ts is exact extension
});

test('lspGlobToRegExp: * stays within a segment, ? is one char', () => {
  assert.ok(lspGlobToRegExp('*.ts').test('a.ts'));
  assert.ok(!lspGlobToRegExp('*.ts').test('dir/a.ts'));
  assert.ok(lspGlobToRegExp('a?.ts').test('ab.ts'));
  assert.ok(!lspGlobToRegExp('a?.ts').test('a/.ts'));
});

test('lspGlobToRegExp: brace alternation and literal names', () => {
  const re = lspGlobToRegExp('**/*.{ts,tsx,js}');
  assert.ok(re.test('src/a.tsx'));
  assert.ok(re.test('a.js'));
  assert.ok(!re.test('a.css'));
  assert.ok(lspGlobToRegExp('**/tsconfig.json').test('packages/x/tsconfig.json'));
  assert.ok(lspGlobToRegExp('**/tsconfig.json').test('tsconfig.json'));
});

test('watcherRegExp: matches absolute paths under the base', () => {
  const re = watcherRegExp('/proj', '**/*.ts');
  assert.ok(re.test('/proj/src/a.ts'));
  assert.ok(re.test('/proj/a.ts'));
  assert.ok(!re.test('/other/a.ts'));
  // The base is matched literally (its dots/specials don't act as wildcards).
  assert.ok(!watcherRegExp('/a.b', '*.ts').test('/axb/a.ts'));
});
