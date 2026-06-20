import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { EditorModel } from './EditorModel.ts';
import { TextDecorations } from './TextDecorations.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { Point } from '../../text/Point.ts';

// The SearchBar owns the GTK widget; here we drive it headlessly to check that
// vim `*`/`#` mirror their search into the bar's value. Gtk.init is idempotent.
Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setCursorBufferPosition(new Point(0, 0));
  const search = new SearchController(editor, new TextDecorations(editor));
  const overlay = new Gtk.Overlay();
  const bar = new SearchBar(overlay, search, view);
  return { editor, search, bar };
}

test('reflectQuery mirrors a `*` search into the bar value without re-searching', () => {
  const { editor, search, bar } = setup('foo foobar foo\n');
  editor.setCursorBufferPosition(new Point(0, 0));
  // `*` — whole-word search; only the two standalone "foo"s match.
  const state = search.searchWord('foo', false);
  assert.equal(state.count, 2);
  bar.reflectQuery('foo');
  // The bar now holds the searched word…
  assert.equal((bar as any).searchEntry.getText(), 'foo');
  // …and the whole-word constraint survived (mirroring did not re-run the query
  // as a plain substring search, which would also match inside "foobar").
  assert.equal(search.state.count, 2);
  assert.deepEqual(editor.getCursorBufferPosition().toArray(), [0, 11]); // 2nd standalone "foo"
});
