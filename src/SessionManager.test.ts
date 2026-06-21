import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import {
  SessionManager,
  SESSION_VERSION,
  type SessionState,
  type TabState,
} from './SessionManager.ts';

// Each test gets its own temp state dir, so the on-disk format is exercised for
// real without touching the user's actual sessions.
function makeManager(): { manager: SessionManager; dir: string } {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-session-'));
  return { manager: new SessionManager(dir), dir };
}

function sessionFor(root: string, name?: string): SessionState {
  const state: SessionState = {
    version: SESSION_VERSION,
    savedAt: '',
    activeWorkspace: 0,
    workspaces: [{ root, layout: { type: 'leaf', tabs: [], activeIndex: 0 } }],
  };
  if (name) state.name = name;
  return state;
}

test('save then load round-trips a session for a root', () => {
  const { manager } = makeManager();
  const root = '/home/me/project';
  const tab: TabState = { kind: 'file', path: '/home/me/project/a.ts', cursor: [3, 5] };
  const state = sessionFor(root);
  state.workspaces[0].layout = { type: 'leaf', tabs: [tab], activeIndex: 0 };

  manager.save(state);
  const loaded = manager.load(root);

  assert.ok(loaded);
  assert.equal(loaded!.version, SESSION_VERSION);
  assert.equal(loaded!.workspaces[0].root, root);
  assert.deepEqual(loaded!.workspaces[0].layout, { type: 'leaf', tabs: [tab], activeIndex: 0 });
});

test('save stamps savedAt with an ISO timestamp', () => {
  const { manager } = makeManager();
  const state = sessionFor('/r');
  manager.save(state);
  const loaded = manager.load('/r')!;
  assert.match(loaded.savedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('unnamed sessions are stored under the root hash, named under the slug', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/home/me/project'));
  manager.save(sessionFor('/home/me/project', 'My Cool Session!'));

  const files = Fs.readdirSync(manager.sessionsDir()).sort();
  assert.equal(files.length, 2);
  assert.ok(files.includes(`${manager.hashRoot('/home/me/project')}.json`));
  assert.ok(files.includes('my-cool-session.json'));
});

test('label is the name when set, else the primary root basename', () => {
  const { manager } = makeManager();
  assert.equal(manager.label(sessionFor('/home/me/project')), 'project');
  assert.equal(manager.label(sessionFor('/home/me/project', 'Work')), 'Work');
});

test('load returns null for a missing session', () => {
  const { manager } = makeManager();
  assert.equal(manager.load('/nope'), null);
});

test('loadPath returns null and does not throw on corrupt JSON', () => {
  const { manager, dir } = makeManager();
  const path = Path.join(dir, 'bad.json');
  Fs.writeFileSync(path, '{ not json');
  assert.equal(manager.loadPath(path), null);
});

test('load rejects an unsupported version', () => {
  const { manager } = makeManager();
  const state = sessionFor('/r');
  manager.save(state);
  // Tamper with the version on disk.
  const path = manager.pathForRoot('/r');
  const onDisk = JSON.parse(Fs.readFileSync(path, 'utf8'));
  onDisk.version = SESSION_VERSION + 1;
  Fs.writeFileSync(path, JSON.stringify(onDisk));
  assert.equal(manager.load('/r'), null);
});

test('load rejects a structurally invalid session', () => {
  const { manager, dir } = makeManager();
  Fs.mkdirSync(dir, { recursive: true });
  Fs.writeFileSync(Path.join(dir, 'x.json'), JSON.stringify({ version: 1, workspaces: [] }));
  assert.equal(manager.loadPath(Path.join(dir, 'x.json')), null);
});

test('list returns every valid session and skips junk', () => {
  const { manager } = makeManager();
  manager.save(sessionFor('/a'));
  manager.save(sessionFor('/b', 'Bee'));
  Fs.writeFileSync(Path.join(manager.sessionsDir(), 'junk.json'), 'nope');
  Fs.writeFileSync(Path.join(manager.sessionsDir(), 'ignore.txt'), 'not json at all');

  const roots = manager.list().map((s) => s.workspaces[0].root).sort();
  assert.deepEqual(roots, ['/a', '/b']);
});

test('delete removes the session file', () => {
  const { manager } = makeManager();
  const state = sessionFor('/r');
  manager.save(state);
  assert.ok(manager.load('/r'));
  manager.delete(state);
  assert.equal(manager.load('/r'), null);
});

test('collectModified returns only participants reporting modified, and respects deregistration', () => {
  const { manager } = makeManager();
  const clean = { isModified: () => false };
  let dirty = true;
  const editor = { isModified: () => dirty, getModifiedLabel: () => 'foo.ts (unsaved)' };

  manager.registerParticipant(clean);
  const reg = manager.registerParticipant(editor);

  assert.deepEqual(manager.collectModified(), [editor]);

  dirty = false; // editor saved
  assert.deepEqual(manager.collectModified(), []);

  dirty = true;
  reg.dispose(); // editor's tab closed
  assert.deepEqual(manager.collectModified(), []);
});

test('deserializer registry builds by kind and unregisters', () => {
  const { manager } = makeManager();
  const fileTab: TabState = { kind: 'file', path: '/a.ts' };
  const termTab: TabState = { kind: 'terminal', cwd: '/' };

  const disposable = manager.registerDeserializer('file', (s) => `built:${(s as any).path}`);
  assert.equal(manager.deserialize(fileTab), 'built:/a.ts');
  assert.equal(manager.deserialize(termTab), null); // no deserializer for terminal

  disposable.dispose();
  assert.equal(manager.deserialize(fileTab), null);
});
