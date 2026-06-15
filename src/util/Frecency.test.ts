import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { FrecencyStore } from './Frecency.ts';

function tmpDir(): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-frecency-'));
}

test('unseen keys score zero and contribute no boost', () => {
  const store = new FrecencyStore(tmpDir());
  assert.equal(store.score('file', '/a'), 0);
  assert.equal(store.boost('file', '/a'), 0);
});

test('recording a key gives it a positive, bounded boost', () => {
  const store = new FrecencyStore(tmpDir());
  store.record('file', '/a');
  const boost = store.boost('file', '/a');
  assert.ok(boost > 0);
  assert.ok(boost <= 1.5);
});

test('a more-used key outranks a less-used one', () => {
  const store = new FrecencyStore(tmpDir());
  store.record('file', '/often');
  store.record('file', '/often');
  store.record('file', '/often');
  store.record('file', '/seldom');
  assert.ok(store.score('file', '/often') > store.score('file', '/seldom'));
});

test('namespaces are independent', () => {
  const store = new FrecencyStore(tmpDir());
  store.record('command', 'save');
  assert.ok(store.score('command', 'save') > 0);
  assert.equal(store.score('file', 'save'), 0);
});

test('records persist across instances sharing a state dir', () => {
  const dir = tmpDir();
  new FrecencyStore(dir).record('file', '/a');
  assert.ok(new FrecencyStore(dir).score('file', '/a') > 0);
});

test('a corrupt store file is tolerated as empty', () => {
  const dir = tmpDir();
  const path = Path.join(dir, 'quilx', 'frecency.json');
  Fs.mkdirSync(Path.dirname(path), { recursive: true });
  Fs.writeFileSync(path, 'not json{');
  const store = new FrecencyStore(dir);
  assert.equal(store.score('file', '/a'), 0);
  store.record('file', '/a'); // still writable
  assert.ok(store.score('file', '/a') > 0);
});
