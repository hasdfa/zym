import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { listWorktrees, worktreeInfo, acquireGitRepo, releaseGitRepo } from '../git.ts';

// Integration test for the worktree backend (Phase 3/4 of the agent worktree
// feature): drive a real repo + a linked worktree with the `git` CLI and assert
// the parse, plus the ref-counted GitRepo pool (acquire/release).

const G = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let dir: string;
let wt: string;

before(() => {
  dir = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-wt-')));
  G(dir, 'init', '-b', 'main');
  G(dir, 'config', 'user.email', 'test@example.com');
  G(dir, 'config', 'user.name', 'Test');
  G(dir, 'config', 'commit.gpgsign', 'false');
  Fs.writeFileSync(Path.join(dir, 'a.txt'), 'x\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-m', 'init');
  wt = `${dir}-linked`;
  G(dir, 'worktree', 'add', '-b', 'feature', wt);
});

after(() => {
  try { G(dir, 'worktree', 'remove', '--force', wt); } catch { /* best effort */ }
  Fs.rmSync(dir, { recursive: true, force: true });
  Fs.rmSync(wt, { recursive: true, force: true });
});

test('listWorktrees returns the main checkout first, then linked worktrees', () => {
  const list = listWorktrees(dir);
  assert.equal(list.length, 2);

  assert.equal(list[0].linked, false);
  assert.equal(list[0].branch, 'main');
  assert.equal(Fs.realpathSync(list[0].path), dir);

  assert.equal(list[1].linked, true);
  assert.equal(list[1].branch, 'feature');
  assert.equal(list[1].name, Path.basename(wt));
  assert.equal(Fs.realpathSync(list[1].path), Fs.realpathSync(wt));
});

test('listWorktrees from inside the linked worktree still lists both', () => {
  assert.equal(listWorktrees(wt).length, 2);
});

test('worktreeInfo flags a linked worktree and its branch', () => {
  const info = worktreeInfo(wt);
  assert.ok(info);
  assert.equal(info.linked, true);
  assert.equal(info.branch, 'feature');
});

test('listWorktrees is empty outside a repository', () => {
  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'quilx-norepo-'));
  try {
    assert.deepEqual(listWorktrees(tmp), []);
  } finally {
    Fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('acquireGitRepo shares one instance per repo root, disposing on last release', () => {
  const a = acquireGitRepo(dir);
  const b = acquireGitRepo(dir); // same root → same pooled instance
  assert.equal(a, b);

  releaseGitRepo(a); // refcount 2 → 1; still alive for the other holder
  const c = acquireGitRepo(dir);
  assert.equal(c, b);

  releaseGitRepo(b);
  releaseGitRepo(c); // last holder released → pooled instance disposed + evicted

  const fresh = acquireGitRepo(dir);
  assert.notEqual(fresh, a); // a brand-new instance, not the disposed one
  releaseGitRepo(fresh);
});

test('a linked worktree pools separately from the main checkout', () => {
  const main = acquireGitRepo(dir);
  const linked = acquireGitRepo(wt); // different top-level → different instance
  assert.notEqual(main, linked);
  releaseGitRepo(main);
  releaseGitRepo(linked);
});
