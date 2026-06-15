import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch } from './fuzzyMatch.ts';

test('empty query matches everything with a neutral score', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('returns null when the query is not a subsequence', () => {
  assert.equal(fuzzyMatch('xyz', 'abc'), null);
  assert.equal(fuzzyMatch('abc', 'ab'), null);
});

test('matching is case-insensitive and records positions in order', () => {
  const match = fuzzyMatch('PIC', 'Picker.ts');
  assert.ok(match);
  assert.deepEqual(match.positions, [0, 1, 2]);
});

test('an exact (whole-string) match scores highest', () => {
  const match = fuzzyMatch('picker.ts', 'Picker.ts')!;
  assert.equal(match.score, Infinity);
  assert.deepEqual(match.positions, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('prefers a consecutive run over an earlier scattered match', () => {
  // The greedy occurrence is f@0,o@2,o@5; the consecutive "foo" is at 4,5,6.
  const match = fuzzyMatch('foo', 'f_o_foo');
  assert.ok(match);
  assert.deepEqual(match.positions, [4, 5, 6]);
});

test('prefers a word-boundary match over an earlier mid-word one', () => {
  // 'p' occurs at 1, 2 (mid-word) and 6 (after the underscore boundary).
  const match = fuzzyMatch('p', 'apple_pie');
  assert.ok(match);
  assert.deepEqual(match.positions, [6]);
});

test('a consecutive match scores higher than a gapped one', () => {
  const consecutive = fuzzyMatch('ab', 'abxx')!;
  const gapped = fuzzyMatch('ab', 'axxb')!;
  assert.ok(consecutive.score > gapped.score);
});

test('boostFrom rewards matches inside the boosted range', () => {
  const plain = fuzzyMatch('ef', 'abcdef')!;
  const boosted = fuzzyMatch('ef', 'abcdef', { boostFrom: 4 })!;
  assert.deepEqual(plain.positions, [4, 5]);
  assert.deepEqual(boosted.positions, [4, 5]);
  assert.ok(boosted.score > plain.score);
});

test('boosting the filename ranks it above a directory-only match', () => {
  // Query "src": one candidate matches it in the directory, the other in the
  // filename. With the filename boosted, the filename match should win.
  const dirHit = fuzzyMatch('src', 'src/ui/Picker.ts', { boostFrom: 7 })!; // filename = Picker.ts
  const fileHit = fuzzyMatch('src', 'lib/util/src.ts', { boostFrom: 9 })!; // filename = src.ts
  assert.ok(fileHit.score > dirHit.score);
});

test('a consecutive run after a colon outranks a boundary match elsewhere', () => {
  // "cont" runs consecutively right after the ':' in agent:continue; in
  // config:open-as-text it only matches c-o-n at the start with a far jump to
  // the 't'. The colon-anchored run should win.
  const agent = fuzzyMatch('cont', 'agent:continue')!;
  const config = fuzzyMatch('cont', 'config:open-as-text')!;
  assert.ok(agent.score > config.score);
});

test('strict matching rejects a typo unless tolerance is enabled', () => {
  assert.equal(fuzzyMatch('tewt', 'TextEditor'), null);
});

test('typo tolerance matches through a single mistyped character', () => {
  // "tewt" → drop the stray "w" → "tet", which is a subsequence of TextEditor.
  const match = fuzzyMatch('tewt', 'TextEditor', { maxTypos: 1 });
  assert.ok(match);
  assert.equal(match.positions.length, 3);
});

test('a typo match ranks below a clean match of the same query', () => {
  const clean = fuzzyMatch('test', 'test.ts', { maxTypos: 1 })!;
  const typo = fuzzyMatch('tesx', 'test.ts', { maxTypos: 1 })!;
  assert.ok(clean.score > typo.score);
});
