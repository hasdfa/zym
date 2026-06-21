/*
 * DiffCommentBox — a small focusable comment input shown inline in the continuous
 * diff (ContinuousDiffView), hosted in the editor's focusable `Peek` (a sibling
 * overlay card, NOT a `BlockDecorations` band: the latter is the non-interactive
 * add_overlay path, where a nested focusable editor leaks IM input — see
 * Peek.ts / BlockDecorations.ts). The body is a buffer-only `TextEditor` (full vim
 * editing), mirroring the agent prompt input (AgentConversation):
 *   - `enter` submits → `onSubmit(text)`,
 *   - `alt-enter` inserts a newline (multi-line comments),
 *   - `escape` cancels → `onCancel()`.
 */
import { Gtk } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { addStyles } from '../styles.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';

addStyles(`
  .diff-comment-box {
    background: var(--t-ui-surface-popover);
    border: 1px solid var(--t-ui-border);
    border-radius: 6px;
    padding: 6px 8px;
  }
  /* Let the card background show through the editor. */
  #DiffCommentInput textview,
  #DiffCommentInput textview text { background: transparent; }
  .diff-comment-hint { color: var(--t-ui-text-muted); padding-top: 4px; }
`);

// The enter/alt-enter/escape keymap is global (selector-scoped to our card),
// registered once for the whole app — not per box instance.
let keymapRegistered = false;
function registerKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  quilx.keymaps.add('diff-comment', {
    '#DiffCommentInput #TextEditor': {
      enter: 'diff-comment:submit',
      'alt-enter': 'diff-comment:newline',
      escape: 'diff-comment:cancel',
    },
  });
}

export interface DiffCommentBoxOptions {
  /** Enter pressed — `text` is the comment as typed (untrimmed). */
  onSubmit: (text: string) => void;
  /** Escape pressed (or otherwise dismissed without submitting). */
  onCancel: () => void;
}

export class DiffCommentBox {
  readonly root: InstanceType<typeof Gtk.Box>;
  /** Reserved-gap height for the hosting Peek, in px. */
  readonly height = 116;
  private readonly input: TextEditor;
  private readonly commands: { dispose(): void };
  private disposed = false;

  constructor(options: DiffCommentBoxOptions) {
    registerKeymapOnce();

    this.input = new TextEditor({ buffer: { placeholder: 'Comment to agent…' } });
    this.input.root.setVexpand(true);
    this.input.root.setHexpand(true);

    const hint = new Gtk.Label({ label: 'Enter to send · Alt+Enter for newline · Esc to cancel', xalign: 0 });
    hint.addCssClass('diff-comment-hint');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('DiffCommentInput');
    this.root.addCssClass('diff-comment-box');
    this.root.append(this.input.root);
    this.root.append(hint);

    this.commands = quilx.commands.add(this.root, {
      'diff-comment:submit': {
        didDispatch: () => options.onSubmit(this.input.getText()),
        description: 'Send the diff comment to the agent',
      },
      'diff-comment:newline': {
        didDispatch: () => this.input.insertText('\n'),
        description: 'Insert a newline in the diff comment',
      },
      'diff-comment:cancel': {
        didDispatch: () => options.onCancel(),
        description: 'Cancel the diff comment',
      },
    });
  }

  focus(): void {
    this.input.focusInsert(); // ready to type immediately, not vim normal mode
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.commands.dispose();
    this.input.dispose();
  }
}
