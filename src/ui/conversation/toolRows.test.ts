import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashRowParts } from './toolRows.ts';

test('Bash with a description shows it on the header, command in the detail', () => {
  const p = bashRowParts({ command: 'git worktree add -b feat/x ../x master', description: 'Create new worktree' });
  assert.equal(p.headerText, 'Create new worktree');
  assert.equal(p.headerIsCommand, false);
  assert.equal(p.detailCommand, 'git worktree add -b feat/x ../x master');
});

test('Bash without a description falls back to the command on the header', () => {
  const p = bashRowParts({ command: 'ls -la' });
  assert.equal(p.headerText, 'ls -la');
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.detailCommand, null);
});

test('a blank/whitespace description is treated as absent', () => {
  const p = bashRowParts({ command: 'pwd', description: '   ' });
  assert.equal(p.headerText, 'pwd');
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.detailCommand, null);
});

test('the description is trimmed for the header', () => {
  const p = bashRowParts({ command: 'pwd', description: '  Show working dir  ' });
  assert.equal(p.headerText, 'Show working dir');
  assert.equal(p.detailCommand, 'pwd');
});

test('a multiline command is carried whole into the detail (header crops elsewhere)', () => {
  const cmd = 'set -e\ncd src\npnpm build';
  const p = bashRowParts({ command: cmd, description: 'Build' });
  assert.equal(p.headerText, 'Build');
  assert.equal(p.detailCommand, cmd);
});

test('a non-string command degrades to a compact summary on the header', () => {
  const p = bashRowParts({ command: { not: 'a string' } });
  assert.equal(p.headerIsCommand, true);
  assert.equal(p.headerText, '{"command":{"not":"a string"}}');
  assert.equal(p.detailCommand, null);
});
