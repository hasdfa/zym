/*
 * buildDefinitionPeek — the card shown by the see-definition inline peek: a header
 * (file:line + close button) over a read-only, syntax-highlighted slice of the
 * definition's file. Lives in the editor's sibling overlay via `editor.showPeek`
 * (Peek); the nested editor is focusable there without leaking input to the
 * file behind it.
 */
import * as Path from 'node:path';
import { Gdk, Gtk } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { addStyles } from '../../styles.ts';
import { TextEditor, INPUT_PADDING } from './TextEditor.ts';

const PEEK_MUTED = theme.ui.text.muted;

addStyles(`
  .peek-card {
    background-color: var(--popover-bg-color);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 1px 4px alpha(black, 0.3);
  }
  .peek-header {
    padding: 2px 4px 2px 8px;
    border-bottom: 1px solid var(--border-color);
  }
  .peek-header label { color: ${PEEK_MUTED}; }
  .peek-header button { min-height: 0; min-width: 0; padding: 2px 6px; }
`);

/** How many lines of the definition's file to show (a couple of lead-in lines plus
 *  the body). The nested editor scrolls if the user wants more. */
const LEAD = 2;
const SPAN = 18;

export interface DefinitionTarget {
  path: string;
  point: { row: number; column: number };
}

/** Px height for the live peek (a fixed window of `SPAN` lines around the def). */
export const LIVE_PEEK_HEIGHT = 30 + SPAN * 20;

/** Wrap a body widget in the peek card chrome (header `file:line` + × close, Escape to
 *  dismiss). Shared by the snapshot peek and the live (shared-document) peek. */
export function wrapPeekBody(
  target: DefinitionTarget,
  body: InstanceType<typeof Gtk.Widget>,
  height: number,
  onClose: () => void,
): { widget: InstanceType<typeof Gtk.Box>; height: number } {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  card.addCssClass('peek-card');

  // Header: "file:line" on the left, a close button on the right.
  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  header.addCssClass('peek-header');
  const title = new Gtk.Label({ label: `${Path.basename(target.path)}:${target.point.row + 1}`, xalign: 0 });
  title.setHexpand(true);
  header.append(title);
  const close = new Gtk.Button({ label: '✕' });
  close.addCssClass('flat');
  close.on('clicked', onClose);
  header.append(close);
  card.append(header);

  body.setVexpand(true);
  card.append(body);

  // Escape closes the peek (capture phase, so it fires before the nested editor's
  // vim layer consumes it). Other keys fall through to the nested editor.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number) => {
    if (keyval === Gdk.KEY_Escape) { onClose(); return true; }
    return false;
  });
  card.addController(keys);

  return { widget: card, height };
}

/** Build the snapshot peek card: a read-only, highlighted slice of the file's text
 *  (used when the file is NOT open — no live document to share). */
export function buildDefinitionPeek(
  target: DefinitionTarget,
  fileContent: string,
  onClose: () => void,
): { widget: InstanceType<typeof Gtk.Box>; height: number } {
  const lines = fileContent.split('\n');
  const start = Math.max(0, target.point.row - LEAD);
  const end = Math.min(lines.length, start + SPAN);
  const slice = lines.slice(start, end).join('\n');

  const editor = new TextEditor({
    // A gutterless code peek: keep the symmetric inset (the editor's `padding` now defaults to 0)
    // so the slice doesn't hug the popover edges.
    buffer: { readOnly: true, initialText: slice, languagePath: target.path, folding: false },
    padding: INPUT_PADDING,
  });
  return wrapPeekBody(target, editor.root, 30 + (end - start) * 20, onClose);
}
