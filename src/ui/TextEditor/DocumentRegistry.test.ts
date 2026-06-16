import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk } from '../../gi.ts';
import { DocumentRegistry } from './DocumentRegistry.ts';

// DocumentRegistry hands out live `Document`s, which wrap a GtkSource buffer — so
// these are integration tests needing GTK initialized. Gtk.init is idempotent.
Gtk.init();

// A real on-disk file so `Document.loadFile` can set `currentFile` (dedup is by the
// document's live file, not the path passed to acquire).
function tempFile(name: string, contents = ''): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-docreg-'));
  const file = Path.join(dir, name);
  Fs.writeFileSync(file, contents);
  return file;
}

test('acquire creates a fresh document the first time, shares it after', () => {
  const reg = new DocumentRegistry();
  const path = tempFile('a.txt', 'hello');

  const first = reg.acquire(path);
  assert.equal(first.isNew, true);
  first.document.loadFile(path); // sets currentFile so the next acquire can dedup

  const second = reg.acquire(path);
  assert.equal(second.isNew, false);
  assert.equal(second.document, first.document); // same shared Document
  assert.equal(reg.documents().length, 1);
});

test('the document survives until the last reference is released', () => {
  const reg = new DocumentRegistry();
  const path = tempFile('b.txt');

  const a = reg.acquire(path);
  a.document.loadFile(path);
  reg.acquire(path); // second view → refs = 2

  reg.release(a.document); // one view gone → still alive
  assert.equal(reg.find(path), a.document);

  reg.release(a.document); // last view gone → disposed + forgotten
  assert.equal(reg.find(path), undefined);
  assert.equal(reg.documents().length, 0);
});

test('distinct paths get distinct documents', () => {
  const reg = new DocumentRegistry();
  const a = reg.acquire(tempFile('one.txt'));
  const b = reg.acquire(tempFile('two.txt'));
  assert.notEqual(a.document, b.document);
  assert.equal(reg.documents().length, 2);
});

test('release of an unknown document is a no-op', () => {
  const reg = new DocumentRegistry();
  const tracked = reg.acquire(tempFile('tracked.txt'));
  const stray = reg.acquire(tempFile('stray.txt')).document;
  reg.release(stray);
  // Releasing `stray` must not have touched `tracked`'s entry.
  assert.equal(reg.documents().includes(tracked.document), true);
});
