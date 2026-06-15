import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPango } from './markdownMarkup.ts';

test('inline code and bold/italic become Pango spans', () => {
  assert.equal(markdownToPango('use `foo` now'), 'use <tt>foo</tt> now');
  assert.equal(markdownToPango('a **bold** b'), 'a <b>bold</b> b');
  assert.equal(markdownToPango('a *it* b'), 'a <i>it</i> b');
  assert.equal(markdownToPango('a __bold__ b'), 'a <b>bold</b> b');
});

test('fenced code block becomes one monospace run (info string dropped)', () => {
  assert.equal(markdownToPango('```ts\nconst x = 1\n```'), '<tt>const x = 1</tt>');
});

test('headings and list items', () => {
  assert.equal(markdownToPango('# Title'), '<b>Title</b>');
  assert.equal(markdownToPango('- one\n- two'), '• one\n• two');
});

test('links render as their text; rules become a divider', () => {
  assert.equal(markdownToPango('see [docs](http://x)'), 'see docs');
  assert.equal(markdownToPango('---'), '──────────');
});

test('Pango metacharacters are escaped, including inside code', () => {
  assert.equal(markdownToPango('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(markdownToPango('`Map<K, V>`'), '<tt>Map&lt;K, V&gt;</tt>');
});

test('code content is not re-processed as bold/italic', () => {
  assert.equal(markdownToPango('`a*b*c`'), '<tt>a*b*c</tt>');
});

test('a code font family wraps code in a face span (escaped) instead of <tt>', () => {
  assert.equal(
    markdownToPango('use `x`', { codeFontFamily: 'JetBrains Mono' }),
    'use <span face="JetBrains Mono">x</span>',
  );
  assert.equal(markdownToPango('```\na\n```', { codeFontFamily: 'Fira Code' }), '<span face="Fira Code">a</span>');
});

test('highlightCode renders a fenced block (wrapped in the code font), with its lang', () => {
  const hl = (code: string, lang: string | undefined) => `<span foreground="#f00">${lang}:${code}</span>`;
  assert.equal(
    markdownToPango('```ts\nx\n```', { codeFontFamily: 'M', highlightCode: hl }),
    '<span face="M"><span foreground="#f00">ts:x</span></span>',
  );
});
