import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from './EditorModel.ts';
import { UnderlineOverlay } from './UnderlineOverlay.ts';
import { Range } from '../../text/Range.ts';

// The Cairo drawing needs a realized, allocated view, so it can't be exercised
// headlessly; these cover construction + the data API (setUnderlines/clear) and
// that they don't throw on an unrealized view. Gtk.init is idempotent.
Gtk.init();

function model(text: string): EditorModel {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  return new EditorModel(view, buffer);
}

test('UnderlineOverlay constructs a DrawingArea and accepts underlines', () => {
  const m = model('hello world\n');
  const overlay = new UnderlineOverlay(m.view, m);
  assert.ok(overlay.widget instanceof Gtk.DrawingArea);
  // No throw on an unrealized view (draw is a no-op until realized).
  overlay.setUnderlines([{ range: new Range([0, 0], [0, 5]), color: '#e01b24' }]);
  overlay.clear();
});