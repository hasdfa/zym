import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { nodeModulesBinDirs, resolveCommand } from './which.ts';

test('nodeModulesBinDirs walks from the root dir up to the filesystem root', () => {
  const dirs = nodeModulesBinDirs('/a/b/c');
  assert.deepEqual(dirs.slice(0, 3), [
    Path.join('/a/b/c', 'node_modules', '.bin'),
    Path.join('/a/b', 'node_modules', '.bin'),
    Path.join('/a', 'node_modules', '.bin'),
  ]);
  // Reaches the root and stops (no infinite loop).
  assert.equal(dirs[dirs.length - 1], Path.join('/', 'node_modules', '.bin'));
});

test('resolveCommand finds an executable in extraDirs before PATH, else null', () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-which-'));
  const bin = Path.join(dir, 'my-lsp');
  Fs.writeFileSync(bin, '#!/bin/sh\n');
  Fs.chmodSync(bin, 0o755);

  assert.equal(resolveCommand('my-lsp', [dir]), bin);
  assert.equal(resolveCommand('definitely-not-installed-xyz', [dir]), null);

  // A non-executable file is not a match.
  const plain = Path.join(dir, 'not-exec');
  Fs.writeFileSync(plain, '', { mode: 0o644 });
  assert.equal(resolveCommand('not-exec', [dir]), null);

  // A slash-bearing command is treated as a literal path.
  assert.equal(resolveCommand(bin), bin);
  assert.equal(resolveCommand(Path.join(dir, 'missing')), null);

  Fs.rmSync(dir, { recursive: true, force: true });
});
