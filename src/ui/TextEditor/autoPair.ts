/*
 * autoPair — auto-close brackets and quotes while typing in insert mode.
 *
 * Pure logic over an EditorModel so it's unit-testable; TextEditor wires it to a
 * key controller on the view. Each entry point returns whether it handled the
 * keystroke (the caller then consumes the key so the view doesn't also insert it).
 *
 * Behaviors:
 *  - opening a bracket inserts the matching close and sits between them;
 *  - typing a closer that's already right after the cursor steps over it instead
 *    of inserting a duplicate ("type-over");
 *  - backspace inside an empty pair deletes both halves.
 *
 * Guards keep it unobtrusive: brackets don't auto-close directly before a word,
 * and quotes don't pair after a word/another quote (so apostrophes and the end of
 * a string stay literal).
 */
import type { EditorModel } from './EditorModel.ts';

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSE_TO_OPEN: Record<string, string> = {};
for (const [open, close] of Object.entries(PAIRS)) CLOSE_TO_OPEN[close] = open;

const isWord = (ch: string): boolean => /\w/.test(ch);

function charAfterCursor(editor: EditorModel): string {
  const pos = editor.getCursorBufferPosition();
  return editor.lineTextForBufferRow(pos.row)[pos.column] ?? '';
}

function charBeforeCursor(editor: EditorModel): string {
  const pos = editor.getCursorBufferPosition();
  if (pos.column === 0) return '';
  return editor.lineTextForBufferRow(pos.row)[pos.column - 1] ?? '';
}

/** Handle a typed character; returns true when auto-pair consumed it. */
export function handleAutoPairInsert(editor: EditorModel, ch: string): boolean {
  const isOpener = PAIRS[ch] !== undefined;
  const isCloser = CLOSE_TO_OPEN[ch] !== undefined;
  if (!isOpener && !isCloser) return false;

  const after = charAfterCursor(editor);

  // Type-over: a closer (or quote) already sitting after the cursor.
  if (isCloser && after === ch) {
    const pos = editor.getCursorBufferPosition();
    editor.setCursorBufferPosition([pos.row, pos.column + 1]);
    return true;
  }
  if (!isOpener) return false; // a bare closer with nothing to step over: insert normally

  const close = PAIRS[ch];
  if (ch === close) {
    const before = charBeforeCursor(editor);
    if (isWord(before) || before === ch || isWord(after)) return false; // apostrophe / string end
  } else if (isWord(after)) {
    return false; // don't wrap a following word
  }

  const pos = editor.getCursorBufferPosition();
  editor.transact(() =>
    editor.setTextInBufferRange([[pos.row, pos.column], [pos.row, pos.column]], ch + close),
  );
  editor.setCursorBufferPosition([pos.row, pos.column + 1]); // between the pair
  return true;
}

/** Handle backspace; returns true when it deleted an empty pair. */
export function handleAutoPairBackspace(editor: EditorModel): boolean {
  const before = charBeforeCursor(editor);
  const after = charAfterCursor(editor);
  if (before && PAIRS[before] === after) {
    const pos = editor.getCursorBufferPosition();
    editor.transact(() =>
      editor.setTextInBufferRange([[pos.row, pos.column - 1], [pos.row, pos.column + 1]], ''),
    );
    return true;
  }
  return false;
}
