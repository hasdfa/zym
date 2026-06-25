import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../../gi.ts';
import { EditorModel } from '../EditorModel.ts';
import { Point } from '../../../text/Point.ts';
import VimState from './vim-state.ts';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.ts';
import './operator.ts';
import './operator-insert.ts';
import './operator-transform-string.ts';
import './text-object.ts';
import './motion.ts';

Gtk.init();

function setup(text: string) {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  const vimState = new VimState(editor, new StatusBarManager());
  const run = (klass: string) => vimState.operationStack.run(klass);
  const at = (row: number, col = 0) => editor.setCursorBufferPosition(new Point(row, col));
  return { editor, vimState, run, at };
}

const TEXT = 'foo bar foo\nbaz foo qux\n';

test('o operator-modifier: `d o p` deletes every occurrence of the cursor word in the paragraph', () => {
  const { editor, vimState, run, at } = setup(TEXT);
  at(0, 0); // on the first `foo`
  run('Delete');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), ' bar \nbaz  qux\n');
});

test('o operator-modifier: `g U o p` upcases every occurrence in the paragraph', () => {
  const { editor, vimState, run, at } = setup(TEXT);
  at(0, 0);
  run('UpperCase');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), 'FOO bar FOO\nbaz FOO qux\n');
});

test('the occurrence is bounded to its target — only `foo` inside the operated range changes', () => {
  // Two paragraphs; operate on the first only.
  const { editor, vimState, run, at } = setup('foo a foo\n\nfoo b foo\n');
  at(0, 0);
  run('Delete');
  vimState.setOperatorModifier({ occurrence: true, occurrenceType: 'base' });
  run('InnerParagraph');
  assert.equal(editor.getText(), ' a \n\nfoo b foo\n'); // second paragraph untouched
});

test('preset occurrence: `g o` arms lazily (no marks until an operator runs), `g o` again disarms', () => {
  const { vimState, run, at } = setup(TEXT);
  at(0, 0);
  run('TogglePresetOccurrence'); // arm on the cursor word (no host → in-vim word pattern)
  const om = vimState.occurrenceManager;
  assert.equal(om.isArmed(), true);
  assert.equal(om.hasMarkers(), false); // lazy: no marks created on arm

  run('TogglePresetOccurrence'); // toggle off
  assert.equal(om.isArmed(), false);
  assert.equal(om.hasMarkers(), false);
});

test('preset occurrence arms on the pattern the search bridge returns (the occurrence↔search bridge)', () => {
  const { vimState, run, at } = setup(TEXT);
  let refreshes = 0;
  // Stand in for the host SearchController: arming resolves to the `foo` search.
  vimState.setOccurrenceSearchProvider({
    armFromCursor: () => /foo/g,
    armFromText: () => null,
    getActivePattern: () => /foo/g,
    refresh: () => {
      refreshes++;
    },
  });
  at(0, 6); // on `bar` — the search pattern (foo) drives occurrence, not the cursor word
  run('TogglePresetOccurrence');
  const om = vimState.occurrenceManager;
  assert.equal(om.isArmed(), true);
  assert.equal(om.armedPattern?.source, 'foo');
  assert.equal(refreshes, 1); // the search highlight was repainted (now armed) once
  assert.equal(om.hasMarkers(), false); // still lazy
});

test('the search render derives from the occurrence armed state (no separate flag to desync)', () => {
  const { vimState, run, at } = setup(TEXT);
  const armedSeen: boolean[] = [];
  vimState.setOccurrenceSearchProvider({
    armFromCursor: () => /foo/g,
    armFromText: () => null,
    getActivePattern: () => /foo/g,
    // A real SearchController reads isOccurrenceArmed() at render time; sample it here.
    refresh: () => armedSeen.push(vimState.isOccurrenceArmed()),
  });
  at(0, 0);
  run('TogglePresetOccurrence'); // arm → render sees armed=true
  run('TogglePresetOccurrence'); // disarm → render sees armed=false
  assert.equal(vimState.occurrenceManager.isArmed(), false);
  assert.deepEqual(armedSeen, [true, false]);
});

test('an armed occurrence materialises marks lazily when an operator runs: `g o` then `d a p`', () => {
  const { editor, vimState, run, at } = setup(TEXT);
  at(0, 0);
  run('TogglePresetOccurrence'); // arm on `foo` (no marks yet)
  assert.equal(vimState.occurrenceManager.hasMarkers(), false); // lazy until an operator needs them
  run('Delete');
  run('AParagraph'); // operator materialises occurrence marks, then deletes them
  assert.equal(editor.getText(), ' bar \nbaz  qux\n');
});

test('armed occurrence is scoped to the operator target: `g o` then `d i p` only touches the first paragraph', () => {
  // Two paragraphs; the scoped scan must not mark/affect the second.
  const { editor, run, at } = setup('foo a foo\n\nfoo b foo\n');
  at(0, 0);
  run('TogglePresetOccurrence'); // arm on `foo`
  run('Delete');
  run('InnerParagraph'); // materialise scoped to the first paragraph, then delete
  assert.equal(editor.getText(), ' a \n\nfoo b foo\n'); // second paragraph untouched
});

test('`ctrl-l` (clearSearchHighlight) disarms occurrence AND clears the search highlight — even after an operation', () => {
  const { vimState, run, at } = setup(TEXT);
  let cleared = 0;
  // The host wires this once at editor setup; it must survive operations.
  vimState.onDidRequestClearSearchHighlight(() => {
    cleared += 1;
  });
  vimState.setOccurrenceSearchProvider({
    armFromCursor: () => /foo/g,
    armFromText: () => null,
    getActivePattern: () => /foo/g,
    refresh: () => {},
  });
  at(0, 0);
  run('TogglePresetOccurrence'); // arm — this runs (and resets) the operation stack
  run('TogglePresetOccurrence'); // disarm — another operation, exercising the reset
  run('TogglePresetOccurrence'); // arm again
  assert.equal(vimState.occurrenceManager.isArmed(), true);

  vimState.clearSearchHighlight(); // ctrl-l
  assert.equal(vimState.occurrenceManager.isArmed(), false); // disarmed
  assert.equal(cleared, 1); // and the `:noh` listener still fired despite prior operations
});
