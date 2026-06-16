/*
 * buildDefinitionPeek — the card shown by the see-definition inline peek: a header
 * (file:line + close button) over a read-only, syntax-highlighted slice of the
 * definition's file. Lives in the editor's sibling overlay via `editor.showPeek`
 * (InlinePeek); the nested editor is focusable there without leaking input to the
 * file behind it.
 */
import * as Path from 'node:path';
import { Gdk, Gtk } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { addStyles } from '../../styles.ts';
import { TextEditor } from './TextEditor.ts';

const PEEK_BG = theme.ui.popoverBg ?? theme.ui.bg ?? '#1e1e1e';
const PEEK_FG = theme.ui.fg ?? '#e0e0e0';
const PEEK_MUTED = theme.ui.textMuted ?? theme.ui.lineNumber ?? PEEK_FG;

addStyles(`
  .peek-card {
    background-color: ${PEEK_BG};
    border: 1px solid alpha(${PEEK_FG}, 0.2);
    border-radius: 6px;
    box-shadow: 0 1px 4px alpha(black, 0.3);
  }
  .peek-header {
    padding: 2px 4px 2px 8px;
    border-bottom: 1px solid alpha(${PEEK_FG}, 0.15);
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

/** Build the peek card. `onClose` is wired to the × button. Returns the widget and
 *  the px height to reserve for it (so the gap matches). */
export function buildDefinitionPeek(
  target: DefinitionTarget,
  fileContent: string,
  onClose: () => void,
): { widget: InstanceType<typeof Gtk.Box>; height: number } {
  const lines = fileContent.split('\n');
  const start = Math.max(0, target.point.row - LEAD);
  const end = Math.min(lines.length, start + SPAN);
  const slice = lines.slice(start, end).join('\n');

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

  // Body: a read-only, highlighted view of the definition slice.
  const editor = new TextEditor({
    buffer: { readOnly: true, initialText: slice, languagePath: target.path, folding: false },
  });
  editor.root.setVexpand(true);
  card.append(editor.root);

  // Escape closes the peek (capture phase, so it fires before the nested editor's
  // vim layer consumes it). Other keys fall through to the nested editor.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number) => {
    if (keyval === Gdk.KEY_Escape) { onClose(); return true; }
    return false;
  });
  card.addController(keys);

  // Height ≈ header + the shown lines (line height ~ 20px; capped by SPAN).
  const height = 30 + (end - start) * 20;
  return { widget: card, height };
}
