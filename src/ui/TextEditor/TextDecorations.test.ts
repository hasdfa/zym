import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { TextDecorations } from './TextDecorations.ts';
import type { PointLike } from '../../text/Point.ts';

// TextDecorations paints GtkTextTags on a live buffer, so these are
// integration tests (GTK initialized, no realized view needed). Gtk.init is idempotent.
Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

/** Whether the decoration tag `tagName` covers the character at `point`. */
function hasTag(m: EditorModel, point: PointLike, tagName: string): boolean {
  const tag = m.buffer.getTagTable().lookup(tagName);
  return tag ? (m.iterAtPoint(point)).hasTag(tag) : false;
}

test('decorate applies a styled tag over the range; clear removes it', () => {
  const m = model('hello world\n');
  const layer = new TextDecorations(m).layer('search');
  layer.decorate([[0, 0], [0, 5]], 'highlight');
  assert.ok(hasTag(m, [0, 2], 'deco:search:highlight')); // inside
  assert.ok(!hasTag(m, [0, 8], 'deco:search:highlight')); // outside
  layer.clear();
  assert.ok(!hasTag(m, [0, 2], 'deco:search:highlight'));
});

test('layers clear independently', () => {
  const m = model('hello world\n');
  const deco = new TextDecorations(m);
  const search = deco.layer('search');
  const diff = deco.layer('diff');
  search.decorate([[0, 0], [0, 5]], 'highlight');
  diff.decorate([[0, 6], [0, 11]], 'added');
  search.clear();
  assert.ok(!hasTag(m, [0, 2], 'deco:search:highlight'));
  assert.ok(hasTag(m, [0, 8], 'deco:diff:added')); // the other layer is untouched
});

test('the same layer instance is returned for a name', () => {
  const deco = new TextDecorations(model('x\n'));
  assert.equal(deco.layer('search'), deco.layer('search'));
});