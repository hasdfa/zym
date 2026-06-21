import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseBlame, formatBlame } from './GitBlameController.ts';

// A `git blame --line-porcelain` block per line: header (`<sha> <orig> <final>`),
// full author/summary fields, then the `\t`-prefixed source line.
const block = (sha: string, finalLine: number, author: string, time: number, summary: string, content: string) =>
  [
    `${sha} ${finalLine} ${finalLine}`,
    `author ${author}`,
    'author-mail <a@b.c>',
    `author-time ${time}`,
    'author-tz +0000',
    `summary ${summary}`,
    'filename foo.ts',
    `\t${content}`,
  ].join('\n');

describe('parseBlame', () => {
  it('maps each final line (0-based) to its commit fields', () => {
    const out = [
      block('a'.repeat(40), 1, 'Ada', 1000, 'first', 'const a = 1'),
      block('b'.repeat(40), 2, 'Babbage', 2000, 'second', 'const b = 2'),
    ].join('\n');

    const map = parseBlame(out);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get(0), { sha: 'a'.repeat(40), author: 'Ada', timestamp: 1000, summary: 'first' });
    assert.deepEqual(map.get(1), { sha: 'b'.repeat(40), author: 'Babbage', timestamp: 2000, summary: 'second' });
  });

  it('keeps the zero sha for an uncommitted line', () => {
    const map = parseBlame(block('0'.repeat(40), 1, 'Not Committed Yet', 9, 'Version of ...', 'new line'));
    assert.equal(map.get(0)?.sha, '0'.repeat(40));
  });

  it('preserves tabs in the source content without mistaking them for a new line block', () => {
    // The content line is indented code (leading tab inside it); only the FIRST tab
    // marks end-of-block, so a tab-indented body must not corrupt parsing.
    const map = parseBlame(block('c'.repeat(40), 1, 'Coder', 5, 'sum', '\tindented = true'));
    assert.equal(map.size, 1);
    assert.equal(map.get(0)?.author, 'Coder');
  });

  it('returns an empty map for empty input', () => {
    assert.equal(parseBlame('').size, 0);
  });
});

describe('formatBlame', () => {
  const info = { sha: 'abcdef1234567890abcdef1234567890abcdef12', author: 'Ada', timestamp: 1000, summary: 'first commit' };

  it('emits the requested tokens, in order, joined by " • "', () => {
    assert.equal(formatBlame(info, '[message, author]'), 'first commit • Ada');
    assert.equal(formatBlame(info, '[author, message]'), 'Ada • first commit');
    assert.equal(formatBlame(info, 'sha'), 'abcdef1');
  });

  it('treats any surrounding punctuation as a separator and ignores unknown tokens', () => {
    assert.equal(formatBlame(info, 'author | nonsense | message'), 'Ada • first commit');
  });

  it('renders a friendly label for an uncommitted (zero-sha) line', () => {
    const uncommitted = { sha: '0'.repeat(40), author: 'Not Committed Yet', timestamp: 0, summary: 'x' };
    assert.equal(formatBlame(uncommitted, '[message, author]'), 'You • Uncommitted changes');
  });
});
