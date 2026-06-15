import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Path from 'node:path';
import { installInvocation, managedServerDir, managedBinDir, managedRoot } from './installer.ts';

test('managed dirs nest the server under the install root, bins in node_modules/.bin', () => {
  const root = managedRoot();
  assert.equal(managedServerDir('eslint'), Path.join(root, 'eslint'));
  assert.equal(managedBinDir('eslint'), Path.join(root, 'eslint', 'node_modules', '.bin'));
  assert.ok(root.endsWith(Path.join('quilx', 'lsp')));
});

test('npm install invocation: single package, with version, and multiple packages', () => {
  assert.deepEqual(installInvocation({ via: 'npm', package: 'typescript-language-server' }), {
    command: 'npm',
    args: ['install', '--no-save', '--no-fund', '--no-audit', 'typescript-language-server'],
  });
  const versioned = installInvocation({ via: 'npm', package: 'foo', version: '1.2.3' }).args;
  assert.equal(versioned[versioned.length - 1], 'foo@1.2.3');
  assert.deepEqual(
    installInvocation({ via: 'npm', package: 'typescript-language-server typescript' }).args,
    ['install', '--no-save', '--no-fund', '--no-audit', 'typescript-language-server', 'typescript'],
  );
});

test('raw command invocation runs the command verbatim', () => {
  assert.deepEqual(installInvocation({ command: ['curl', '-L', 'https://example/server'] }), {
    command: 'curl',
    args: ['-L', 'https://example/server'],
  });
});
