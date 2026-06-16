import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseNumstat, parseLsFiles } from './status.ts';

// Porcelain v2 -z uses NUL terminators on every record (headers included).
const Z = (...records: string[]) => records.map((r) => r + '\0').join('');

test('parseStatus: clean repo on a branch', () => {
  const s = parseStatus(Z('# branch.oid abc1234def', '# branch.head main'));
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
  assert.equal(s.conflicts, false);
  assert.deepEqual(s.entries, []);
});

test('parseStatus: ahead/behind from branch.ab', () => {
  const s = parseStatus(Z('# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'));
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
});

test('parseStatus: detached HEAD → short SHA', () => {
  const s = parseStatus(Z('# branch.oid 0123456789abcdef', '# branch.head (detached)'));
  assert.equal(s.branch, '0123456'); // 7-char abbreviation
});

test('parseStatus: unborn branch keeps the branch name', () => {
  const s = parseStatus(Z('# branch.oid (initial)', '# branch.head main'));
  assert.equal(s.branch, 'main');
});

test('parseStatus: tracked modified (worktree only) vs staged', () => {
  const s = parseStatus(
    Z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts', // unstaged only
      '1 M. N... 100644 100644 100644 ccc ddd src/b.ts', // staged only
      '1 MM N... 100644 100644 100644 eee fff src/c.ts', // both
    ),
  );
  assert.deepEqual(
    s.entries.map((e) => [e.relPath, e.staged, e.unstaged, e.untracked, e.conflicted]),
    [
      ['src/a.ts', false, true, false, false],
      ['src/b.ts', true, false, false, false],
      ['src/c.ts', true, true, false, false],
    ],
  );
});

test('parseStatus: untracked', () => {
  const s = parseStatus(Z('# branch.head main', '? new file.txt'));
  assert.equal(s.entries.length, 1);
  assert.deepEqual(
    [s.entries[0].relPath, s.entries[0].untracked, s.entries[0].unstaged],
    ['new file.txt', true, true], // path with a space preserved
  );
});

test('parseStatus: ignored entries are skipped', () => {
  const s = parseStatus(Z('# branch.head main', '! dist/bundle.js'));
  assert.deepEqual(s.entries, []);
});

test('parseStatus: rename consumes the original-path token', () => {
  const s = parseStatus(
    Z(
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts',
      'old/name.ts', // original path — must be consumed, not parsed as an entry
      '1 .M N... 100644 100644 100644 ccc ddd after.ts',
    ),
  );
  assert.deepEqual(
    s.entries.map((e) => e.relPath),
    ['new/name.ts', 'after.ts'],
  );
  assert.equal(s.entries[0].staged, true);
});

test('parseStatus: conflicts', () => {
  const s = parseStatus(
    Z('# branch.head main', 'u UU N... 100644 100644 100644 100644 a b c conflict.ts'),
  );
  assert.equal(s.conflicts, true);
  assert.equal(s.entries[0].conflicted, true);
  assert.equal(s.entries[0].relPath, 'conflict.ts');
});

test('parseStatus: empty input', () => {
  const s = parseStatus('');
  assert.deepEqual(s, { branch: null, ahead: null, behind: null, conflicts: false, entries: [] });
});

test('parseNumstat: normal + binary', () => {
  const m = parseNumstat(Z('3\t1\tsrc/a.ts', '-\t-\timg/logo.png', '10\t0\tdocs/new.md'));
  assert.deepEqual(m.get('src/a.ts'), { added: 3, removed: 1 });
  assert.deepEqual(m.get('img/logo.png'), { added: 0, removed: 0 }); // binary
  assert.deepEqual(m.get('docs/new.md'), { added: 10, removed: 0 });
  assert.equal(m.size, 3);
});

test('parseNumstat: rename (old\\0new tokens)', () => {
  // "<a>\t<r>\t" then old path, then new path, each NUL-terminated.
  const m = parseNumstat('5\t2\t\0old/x.ts\0new/x.ts\0' + '1\t1\tplain.ts\0');
  assert.deepEqual(m.get('new/x.ts'), { added: 5, removed: 2 });
  assert.equal(m.has('old/x.ts'), false);
  assert.deepEqual(m.get('plain.ts'), { added: 1, removed: 1 });
});

test('parseNumstat: empty input', () => {
  assert.equal(parseNumstat('').size, 0);
});

test('parseLsFiles: paths with spaces, trailing NUL', () => {
  assert.deepEqual(parseLsFiles('a.ts\0dir/b c.ts\0'), ['a.ts', 'dir/b c.ts']);
  assert.deepEqual(parseLsFiles(''), []);
});
