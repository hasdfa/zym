import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector } from './selectors.ts';

// A selector parses to one Rule (single, comma-free selectors below).
const specificityOf = (selector: string) => parseSelector(selector)[0].specificity;

test('specificity orders id > class > tag', () => {
  const id = specificityOf('#Panel');
  const cls = specificityOf('.panel');
  const tag = specificityOf('GtkText');
  assert.ok(id > cls, 'an id outranks a class');
  assert.ok(cls > tag, 'a class outranks a tag');
});

test('specificity: a more specific compound selector outranks a plain one', () => {
  // `#Panel .foo` (id + class) beats `.foo` (class), so it wins an equal-priority tie.
  assert.ok(specificityOf('#Panel .foo') > specificityOf('.foo'));
  // Extra classes add up: `.a.b` beats `.a`.
  assert.ok(specificityOf('.a.b') > specificityOf('.a'));
});

test('specificity: a :not() argument counts as a class', () => {
  // `:not(.mini)` contributes its argument's class specificity, like CSS.
  assert.equal(specificityOf('TextEditor:not(.mini)'), specificityOf('TextEditor.mini'));
  assert.ok(specificityOf('TextEditor:not(.mini)') > specificityOf('TextEditor'));
});

test('specificity: many tags never carry into the class column', () => {
  // The encoding must keep an id strictly above any realistic pile of tags.
  assert.ok(specificityOf('#Panel') > specificityOf('a b c d e f g h i j'));
});
