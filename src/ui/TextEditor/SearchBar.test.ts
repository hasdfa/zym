import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { EditorModel } from './EditorModel.ts';
import { TextDecorations } from './TextDecorations.ts';
import { SearchController } from './SearchController.ts';
import { SearchBar } from './SearchBar.ts';
import { Point } from '../../text/Point.ts';

// The SearchBar owns the GTK widget; here we drive it headlessly to check that
// vim `*`/`#` mirror their search into the bar's value and that the match count
// surfaces the no-results warning. Gtk.init is idempotent.
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

test('no-results: a compiling query that matches nothing warns on the count label', () => {
  const { bar } = setup('foo bar baz\n');
  const searchEntry = (bar as any).searchEntry as InstanceType<typeof Gtk.Entry>;
  const countLabel = (bar as any).countLabel as InstanceType<typeof Gtk.Label>;

  searchEntry.setText('foo'); // a match — plain count, no warning
  assert.equal(countLabel.getLabel(), '1/1');
  assert.ok(!countLabel.hasCssClass('no-results'));
  assert.ok(!searchEntry.hasCssClass('no-results'));

  searchEntry.setText('zzz'); // no match — warning on the count and the entry outline
  assert.equal(countLabel.getLabel(), 'No results');
  assert.ok(countLabel.hasCssClass('no-results'));
  assert.ok(searchEntry.hasCssClass('no-results'));

  searchEntry.setText(''); // empty query clears the warning entirely
  assert.equal(countLabel.getLabel(), '');
  assert.ok(!countLabel.hasCssClass('no-results'));
  assert.ok(!searchEntry.hasCssClass('no-results'));
});

test('bad pattern: an uncompilable regex keeps the entry error tint, not the warning', () => {
  const { bar } = setup('foo bar baz\n');
  const searchEntry = (bar as any).searchEntry as InstanceType<typeof Gtk.Entry>;
  const countLabel = (bar as any).countLabel as InstanceType<typeof Gtk.Label>;

  (bar as any).regexToggle.setActive(true);
  searchEntry.setText('['); // does not compile
  assert.equal(countLabel.getLabel(), 'Bad pattern');
  assert.ok(!countLabel.hasCssClass('no-results')); // an error, not a no-match warning
  assert.ok(!searchEntry.hasCssClass('no-results'));
  assert.ok(searchEntry.hasCssClass('invalid'));
});
