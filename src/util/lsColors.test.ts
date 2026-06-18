import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LsColors } from './lsColors.ts';

test('fromEnv returns null for an empty/unset value', () => {
  // Passing the value explicitly avoids depending on the ambient $LS_COLORS (an
  // omitted arg intentionally falls back to process.env.LS_COLORS).
  assert.equal(LsColors.fromEnv(''), null);
});

test('directory and symlink type codes win by kind', () => {
  const ls = new LsColors('di=01;34:ln=01;36:fi=00');
  assert.deepEqual(ls.styleFor('src', { isDir: true }), { bold: true, fg: '#5c5cff' });
  assert.deepEqual(ls.styleFor('link', { isSymlink: true }), { bold: true, fg: '#00ffff' });
});

test('longest matching glob suffix wins, falling back to fi', () => {
  const ls = new LsColors('fi=00:*.gz=01;31:*.tar.gz=01;33');
  assert.equal(ls.styleFor('a.tar.gz')?.fg, '#ffff00'); // .tar.gz beats .gz
  assert.equal(ls.styleFor('a.gz')?.fg, '#ff0000');
  assert.deepEqual(ls.styleFor('plain.txt'), {}); // fi=00 → no styling
});

test('256-color and truecolor foregrounds resolve to hex', () => {
  const ls = new LsColors('*.a=38;5;208:*.b=38;2;10;20;30:*.c=04');
  assert.equal(ls.styleFor('x.a')?.fg, '#ff8700'); // xterm 208
  assert.equal(ls.styleFor('x.b')?.fg, '#0a141e');
  assert.deepEqual(ls.styleFor('x.c'), { underline: true });
});
