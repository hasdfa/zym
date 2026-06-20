/*
 * Tests for the color-preview plugin's pure parsing/contrast helpers — the regex
 * recognizer, hex / rgb() / hsl() parsing, and the readable-foreground choice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_LITERAL_RE, colorTint, parseColorLiteral } from './colors.ts';

/** All literals the scan regex finds in `text`. */
function matches(text: string): string[] {
  return text.match(COLOR_LITERAL_RE) ?? [];
}

test('regex finds hex and functional literals, skips non-colors', () => {
  assert.deepEqual(matches('color: #f00; background: #ff0000aa;'), ['#f00', '#ff0000aa']);
  assert.deepEqual(matches('a: rgb(255, 0, 0); b: hsla(120 50% 50% / .5)'), ['rgb(255, 0, 0)', 'hsla(120 50% 50% / .5)']);
  // word boundary: don't match inside a longer hex-ish word, and ignore 0x / ids
  assert.deepEqual(matches('id #fffword and 0xfff'), []);
});

test('hex parsing (3/4/6/8 digits)', () => {
  assert.deepEqual(parseColorLiteral('#f00'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColorLiteral('#ff000080'), { r: 255, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColorLiteral('#00ff00'), { r: 0, g: 255, b: 0, a: 1 });
  assert.deepEqual(parseColorLiteral('#0f08'), { r: 0, g: 255, b: 0, a: 136 / 255 });
});

test('rgb()/rgba() parsing — commas, spaces, percent, alpha', () => {
  assert.deepEqual(parseColorLiteral('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColorLiteral('rgb(255 0 0 / 50%)'), { r: 255, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColorLiteral('rgba(0, 128, 255, 0.5)'), { r: 0, g: 128, b: 255, a: 0.5 });
  assert.deepEqual(parseColorLiteral('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0, a: 1 });
});

test('hsl()/hsla() parsing', () => {
  assert.deepEqual(parseColorLiteral('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColorLiteral('hsl(120 100% 50%)'), { r: 0, g: 255, b: 0, a: 1 });
  const blue = parseColorLiteral('hsla(240, 100%, 50%, 0.5)');
  assert.deepEqual(blue, { r: 0, g: 0, b: 255, a: 0.5 });
});

test('invalid literals parse to null', () => {
  assert.equal(parseColorLiteral('#12'), null);
  assert.equal(parseColorLiteral('rgb(255, 0)'), null);
  assert.equal(parseColorLiteral('hsl(nope, x, y)'), null);
  assert.equal(parseColorLiteral('teal'), null); // named colors are out of scope
});

test('colorTint: background normalized + readable foreground', () => {
  assert.deepEqual(colorTint('#fff'), { background: '#ffffff', foreground: '#000000' });
  assert.deepEqual(colorTint('#000'), { background: '#000000', foreground: '#ffffff' });
  // translucent → 8-digit background
  assert.deepEqual(colorTint('rgba(255, 0, 0, 0.5)'), { background: '#ff000080', foreground: '#ffffff' });
  // bright yellow reads with black; navy reads with white
  assert.equal(colorTint('#ffff00')!.foreground, '#000000');
  assert.equal(colorTint('rgb(0,0,128)')!.foreground, '#ffffff');
  assert.equal(colorTint('not-a-color'), null);
});
