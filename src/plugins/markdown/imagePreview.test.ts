/*
 * Tests for the markdown image-preview plugin's pure helpers — the image-link
 * recognizer (IMAGE_RE) and the local-path resolution (resolveImagePath).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Path from 'node:path';
import { IMAGE_RE, resolveImagePath } from './imagePreview.ts';

/** The captured `src` of every image link in `text`. */
function srcs(text: string): string[] {
  return [...text.matchAll(IMAGE_RE)].map((m) => m[1]);
}

test('IMAGE_RE: captures image sources, ignoring titles and plain links', () => {
  assert.deepEqual(srcs('![alt](img.png)'), ['img.png']);
  assert.deepEqual(srcs('![](a.png)'), ['a.png']); // empty alt
  assert.deepEqual(srcs('![x](a.png "a title")'), ['a.png']); // title excluded
  assert.deepEqual(srcs("![x](a.png 'a title')"), ['a.png']);
  assert.deepEqual(srcs('![x](<a b.png>)'), ['<a b.png>']); // angle-wrapped (spaces)
  assert.deepEqual(srcs('see ![logo](./logo.svg) here'), ['./logo.svg']); // mid-line
  assert.deepEqual(srcs('a [link](page.html) not an image'), []); // link, not image
  assert.deepEqual(srcs('no image here'), []);
  assert.deepEqual(srcs('![one](1.png) and ![two](2.png)'), ['1.png', '2.png']);
});

test('resolveImagePath: relative paths resolve against the document directory', () => {
  const doc = '/home/u/notes/readme.md';
  assert.equal(resolveImagePath('pic.png', doc), '/home/u/notes/pic.png');
  assert.equal(resolveImagePath('./img/pic.png', doc), '/home/u/notes/img/pic.png');
  assert.equal(resolveImagePath('../assets/pic.png', doc), '/home/u/assets/pic.png');
});

test('resolveImagePath: absolute and file:// paths pass through', () => {
  assert.equal(resolveImagePath('/abs/pic.png', '/doc.md'), '/abs/pic.png');
  assert.equal(resolveImagePath('file:///abs/pic.png', '/doc.md'), '/abs/pic.png');
});

test('resolveImagePath: angle-wrapped and percent-encoded sources', () => {
  const doc = '/home/u/readme.md';
  assert.equal(resolveImagePath('<a b.png>', doc), Path.join('/home/u', 'a b.png'));
  assert.equal(resolveImagePath('my%20pic.png', doc), Path.join('/home/u', 'my pic.png'));
});

test('resolveImagePath: remote / unsupported sources return null', () => {
  const doc = '/doc.md';
  assert.equal(resolveImagePath('https://example.com/a.png', doc), null);
  assert.equal(resolveImagePath('http://example.com/a.png', doc), null);
  assert.equal(resolveImagePath('data:image/png;base64,AAAA', doc), null);
  assert.equal(resolveImagePath('', doc), null);
  assert.equal(resolveImagePath('relative.png', null), null); // no doc dir to anchor to
});
