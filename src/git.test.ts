import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { openGitRepo, type GitRepo } from './git.ts';

// Integration test: drive a throwaway repo with the real `git` CLI and assert the
// CLI-backed GitRepo's synchronous (seeded) reads. The async poll/monitor need the
// GLib loop, but the constructor seeds state synchronously — which is what these
// getters return — so no loop is required here.

const G = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let dir: string;
let bare: string;
let repo: GitRepo;

before(() => {
  dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-git-'));
  bare = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-git-bare-'));
  execFileSync('git', ['init', '--bare'], { cwd: bare });

  G(dir, 'init', '-b', 'main');
  G(dir, 'config', 'user.email', 'test@example.com');
  G(dir, 'config', 'user.name', 'Test');
  G(dir, 'config', 'commit.gpgsign', 'false');

  Fs.writeFileSync(Path.join(dir, 'a.txt'), '1\n2\n3\n');
  Fs.writeFileSync(Path.join(dir, 'keep.txt'), 'x\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-m', 'init');

  // Publish to the bare remote, then make a local-only commit → ahead by 1.
  G(dir, 'remote', 'add', 'origin', bare);
  G(dir, 'push', '-u', 'origin', 'main');
  Fs.appendFileSync(Path.join(dir, 'keep.txt'), 'y\n');
  G(dir, 'commit', '-am', 'second');

  // Working tree: modify a tracked file (+1 line) and add an untracked file.
  Fs.writeFileSync(Path.join(dir, 'a.txt'), '1\n2\n3\n4\n');
  Fs.writeFileSync(Path.join(dir, 'untracked.txt'), 'hello\n');

  repo = openGitRepo(dir);
});

after(() => {
  repo?.dispose();
  Fs.rmSync(dir, { recursive: true, force: true });
  Fs.rmSync(bare, { recursive: true, force: true });
});

test('getBranch returns the current branch', () => {
  assert.equal(repo.getBranch(), 'main');
});

test('getStatus counts tracked changes plus untracked files as insertions', () => {
  // a.txt: +1 tracked line; untracked.txt: 1 new line counted as an insertion.
  assert.deepEqual(repo.getStatus(), { added: 2, removed: 0 });
});

test('getAheadBehind reflects the upstream', () => {
  assert.deepEqual(repo.getAheadBehind(), { ahead: 1, behind: 0 });
});

test('hasConflicts is false on a clean merge state', () => {
  assert.equal(repo.hasConflicts(), false);
});

test('getFileStatuses: tracked modified vs untracked', () => {
  const statuses = repo.getFileStatuses();
  const byName = new Map([...statuses].map(([abs, s]) => [Path.basename(abs), s]));
  assert.deepEqual(byName.get('a.txt'), { kind: 'modified', added: 1, removed: 0 });
  assert.deepEqual(byName.get('untracked.txt'), { kind: 'untracked' });
});

test('getTrackedPaths lists tracked files only (absolute)', () => {
  const names = new Set([...repo.getTrackedPaths()].map((p) => Path.basename(p)));
  assert.ok(names.has('a.txt'));
  assert.ok(names.has('keep.txt'));
  assert.ok(!names.has('untracked.txt'));
  for (const p of repo.getTrackedPaths()) assert.ok(Path.isAbsolute(p));
});

test('untracked insertions: text counted (incl. no trailing newline), binary → 0', () => {
  const d = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-git-u-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: d });
    Fs.writeFileSync(Path.join(d, 'multi.txt'), 'a\nb\nc'); // 3 lines, no trailing \n
    Fs.writeFileSync(Path.join(d, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4])); // NUL → binary
    const r = openGitRepo(d);
    // 3 from multi.txt, 0 from the binary file
    assert.deepEqual(r.getStatus(), { added: 3, removed: 0 });
    r.dispose();
  } finally {
    Fs.rmSync(d, { recursive: true, force: true });
  }
});

test('beginOperation toggles busy, notifies, and is idempotent', () => {
  const d = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-git-op-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: d });
    const r = openGitRepo(d);
    let notifications = 0;
    const unsub = r.onChange(() => notifications++);

    assert.equal(r.isBusy(), false);
    const end = r.beginOperation();
    assert.equal(r.isBusy(), true);
    assert.ok(notifications >= 1, 'onChange fires on the busy transition');

    end();
    assert.equal(r.isBusy(), false);
    const after = notifications;
    end(); // idempotent — no further busy change/notify
    assert.equal(r.isBusy(), false);
    assert.equal(notifications, after);

    unsub();
    r.dispose();
  } finally {
    Fs.rmSync(d, { recursive: true, force: true });
  }
});

test('outside a repo: null/empty, never throws', () => {
  const plain = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-nogit-'));
  try {
    const r = openGitRepo(plain);
    assert.equal(r.getBranch(), null);
    assert.equal(r.getStatus(), null);
    assert.equal(r.getAheadBehind(), null);
    assert.equal(r.hasConflicts(), false);
    assert.equal(r.getFileStatuses().size, 0);
    assert.equal(r.getTrackedPaths().size, 0);
    r.dispose();
  } finally {
    Fs.rmSync(plain, { recursive: true, force: true });
  }
});
