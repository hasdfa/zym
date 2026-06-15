import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regexSpans, replacementSpans } from './regexHighlight.ts';

/** The substrings the spans cover, in order — enough to check tokenization. */
function tokens(source: string, spans: { start: number; end: number }[]): string[] {
  return spans.map((s) => source.slice(s.start, s.end));
}

test('regexSpans colors metacharacters but not literals', () => {
  const src = 'a.b*';
  assert.deepEqual(tokens(src, regexSpans(src)), ['.', '*']);
});

test('regexSpans colors groups, escapes, and quantifiers', () => {
  const src = '(\\d+)';
  assert.deepEqual(tokens(src, regexSpans(src)), ['(', '\\d', '+', ')']);
});

test('regexSpans colors a whole character class', () => {
  const src = '[a-z]';
  assert.deepEqual(tokens(src, regexSpans(src)), ['[', 'a', '-', 'z', ']']);
});

test('replacementSpans colors $-references', () => {
  const src = '$1-$&-$<name>-plain';
  assert.deepEqual(tokens(src, replacementSpans(src)), ['$1', '$&', '$<name>']);
});
