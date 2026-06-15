import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { createBufferWordsSource } from './createBufferWordsSource.ts';
import type { CompletionContext, CompletionItem } from './CompletionSource.ts';

function ctx(prefix: string): CompletionContext {
  const cursor = new Point(0, prefix.length);
  return {
    prefix,
    cursor,
    replaceRange: new Range(new Point(0, 0), cursor),
    line: prefix,
    trigger: 'auto',
  };
}

function complete(text: string, prefix: string): CompletionItem[] {
  const source = createBufferWordsSource(() => text);
  return source.complete(ctx(prefix)) as CompletionItem[];
}

describe('createBufferWordsSource', () => {
  it('offers identifier-like words from the buffer', () => {
    const labels = complete('const handleClick = () => handleClick()', 'han').map((i) => i.label);
    assert.ok(labels.includes('handleClick'));
    assert.ok(labels.includes('const'));
  });

  it('deduplicates repeated words', () => {
    const items = complete('foo foo foo bar', '');
    const foos = items.filter((i) => i.label === 'foo');
    assert.equal(foos.length, 1);
  });

  it('skips single-character tokens', () => {
    const labels = complete('a bb ccc', '').map((i) => i.label);
    assert.deepEqual(labels.sort(), ['bb', 'ccc']);
  });

  it('does not offer the exact word being typed', () => {
    // "view" appears only as the partial under the cursor → nothing to offer it.
    const labels = complete('view', 'view').map((i) => i.label);
    assert.ok(!labels.includes('view'));
  });

  it('ranks more-frequent words first via sortText', () => {
    // `rare` once, `common` three times → common should sort ahead.
    const items = complete('common common common rare', '');
    items.sort((a, b) => (a.sortText! < b.sortText! ? -1 : 1));
    assert.equal(items[0].label, 'common');
  });

  it('handles unicode identifiers', () => {
    const labels = complete('const café = 1; café', 'caf').map((i) => i.label);
    assert.ok(labels.includes('café'));
  });
});
