import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../gi.ts';
import { SyntaxController, isLineFolded, FOLD_HIDDEN_TAG_NAME } from './syntax-controller.ts';

Gtk.init();

// SyntaxController is normally built inside the app's activate handler; it builds
// safely headless too. These tests drive `revealLine` directly by registering fold
// regions + applying the hide tag (the parse-driven path needs a grammar).
function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const syntax = new SyntaxController(view, buffer, {});
  const iter = (line: number) => {
    const r = (buffer as any).getIterAtLine(line);
    return Array.isArray(r) ? r[r.length - 1] : r;
  };
  // Mark lines [startLine+1, endLine) hidden and register the region as folded.
  const fold = (startLine: number, endLine: number) => {
    buffer.applyTag(buffer.getTagTable().lookup(FOLD_HIDDEN_TAG_NAME)!, iter(startLine + 1), iter(endLine));
    syntax.foldsByHeaderLine.set(startLine, { startLine, endLine, folded: true });
  };
  return { buffer, syntax, fold };
}

test('revealLine opens the fold hiding a line and reports the change', () => {
  const { buffer, syntax, fold } = setup('header\n  body1\n  body2\nend\nafter\n');
  fold(0, 3); // body lines 1,2 hidden
  assert.equal(isLineFolded(buffer, 1), true);
  assert.equal(syntax.revealLine(1), true);
  assert.equal(isLineFolded(buffer, 1), false);
});

test('revealLine is a no-op on a visible line (a fold header never auto-opens)', () => {
  const { buffer, syntax, fold } = setup('header\n  body\nend\n');
  fold(0, 2);
  // line 0 is the header (always visible); revealing it must not open the fold
  assert.equal(syntax.revealLine(0), false);
  assert.equal(isLineFolded(buffer, 1), true); // body stays hidden
});

test('revealLine exposes a line buried under nested folds', () => {
  const { buffer, syntax, fold } = setup('outer\n inner\n  deep\n end\nclose\nafter\n');
  fold(0, 4); // outer hides lines 1..3
  fold(1, 3); // inner hides line 2
  assert.equal(isLineFolded(buffer, 2), true);
  assert.equal(syntax.revealLine(2), true);
  assert.equal(isLineFolded(buffer, 2), false);
});
