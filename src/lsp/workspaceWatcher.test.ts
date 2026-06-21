import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { WorkspaceWatcher, type FileChange } from './workspaceWatcher.ts';

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('WorkspaceWatcher reports create / change / delete, and ignores node_modules', async () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-watch-'));
  Fs.mkdirSync(Path.join(dir, 'node_modules'));
  const changes: FileChange[] = [];
  const watcher = new WorkspaceWatcher(dir, (batch) => changes.push(...batch));
  watcher.start();
  await settle(100);

  const file = Path.join(dir, 'foo.ts');
  const typesFor = (p: string) => changes.filter((c) => c.path === p).map((c) => c.type);

  Fs.writeFileSync(file, 'a');
  await settle();
  assert.deepEqual(typesFor(file).slice(0, 1), [1]); // Created

  Fs.appendFileSync(file, 'b');
  await settle();
  assert.ok(typesFor(file).includes(2), 'a Changed event after modify'); // Changed

  Fs.rmSync(file);
  await settle();
  const types = typesFor(file);
  assert.equal(types[types.length - 1], 3); // Deleted last

  // Churn inside node_modules must produce no events.
  const before = changes.length;
  Fs.writeFileSync(Path.join(dir, 'node_modules', 'x.js'), 'x');
  await settle();
  assert.equal(changes.length, before, 'node_modules changes are ignored');

  watcher.dispose();
  Fs.rmSync(dir, { recursive: true, force: true });
});
