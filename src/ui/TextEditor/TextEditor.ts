/*
 * TextEditor — a single file's editor widget: a GtkSource.View + Buffer with
 * tree-sitter highlighting and folding (SyntaxController), custom vim modal
 * editing (the vendored vim-mode-plus core, via `attachVim`), and a minimap. One
 * TextEditor per open file (one per tab). It owns its file I/O, its fold-key
 * bindings, and follows the system light/dark scheme. The assembled widget is
 * exposed via `root`.
 *
 * Load/save failures are reported through the injected `onToast` callback (the
 * toast overlay is window-level).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { SyntaxController } from '../../syntax/syntax-controller.ts';
import { theme } from '../../theme/theme.ts';
import { createSourceScheme } from '../../theme/createSourceScheme.ts';
import { addStyles } from '../../styles.ts';
import { EditorModel } from './EditorModel.ts';
import { attachVim } from './vim/index.ts';
import type { TabState } from '../../SessionManager.ts';
import {
  Adw,
  Gtk,
  GtkSource,
  type SourceBuffer,
  type SourceView,
} from '../../gi.ts';

addStyles(`.quilx-editor { color: ${theme.ui.fg}; caret-color: ${theme.ui.fg}; }`);

const TAB_WIDTH = 4;
const RIGHT_MARGIN = 80;

type VimState = ReturnType<typeof attachVim>;

/**
 * The window's status line reads the active editor's vim state through this
 * (kept signal-shaped — `on('notify::…')` + getters — so AppWindow's wiring is
 * the same as it was for GtkSource.VimIMContext). `command-bar-text` carries the
 * mode indicator (and, later, the `:`/`/` command line); `command-text` is the
 * pending-command preview.
 */
export interface VimStatusLine {
  on(signal: 'notify::command-bar-text' | 'notify::command-text', callback: () => void): void;
  getCommandBarText(): string;
  getCommandText(): string;
}

const VISUAL_LABEL: Record<string, string> = {
  characterwise: '-- VISUAL --',
  linewise: '-- VISUAL LINE --',
  blockwise: '-- VISUAL BLOCK --',
};

/** Bridge VimState's mode/operation events to AppWindow's status line. */
function createVimStatus(vimState: VimState): VimStatusLine {
  const listeners: Record<string, Array<() => void>> = {};
  const fire = (signal: string) => listeners[signal]?.forEach((cb) => cb());
  // The mode indicator changes with the mode; refresh the command bar on both
  // edges so it clears when returning to normal.
  vimState.onDidActivateMode(() => fire('notify::command-bar-text'));
  vimState.onDidDeactivateMode(() => fire('notify::command-bar-text'));

  return {
    on(signal, callback) {
      (listeners[signal] ??= []).push(callback);
    },
    getCommandBarText() {
      // vim convention: mode shown bottom-left; normal mode shows nothing. The
      // `:`/`/` command line will take precedence here once it lands.
      if (vimState.mode === 'insert') return '-- INSERT --';
      if (vimState.mode === 'visual') return VISUAL_LABEL[vimState.submode] ?? '-- VISUAL --';
      return '';
    },
    getCommandText() {
      return '';
    },
  };
}

export interface TextEditorOptions {
  /** Surface a load/save message (the toast overlay is window-level). */
  onToast?: (message: string) => void;
  /**
   * Close request for this editor. Was fired by the `:q`/`:wq`/`:x` ex-commands;
   * dormant until the custom vim layer grows an ex-command line. Closing is
   * available meanwhile through the window's `tab:close`/`pane:close` commands.
   */
  onClose?: () => void;
}

export class TextEditor {
  readonly root: InstanceType<typeof Gtk.Box>;
  readonly vim: VimStatusLine;

  private readonly buffer: SourceBuffer;
  private readonly view: SourceView;
  private readonly syntax: SyntaxController;
  private readonly editorModel: EditorModel;
  private readonly vimState: VimState;
  private readonly onToast: (message: string) => void;

  private _currentFile: string | null = null;
  private readonly titleHandlers: Array<() => void> = [];

  constructor(options: TextEditorOptions = {}) {
    this.onToast = options.onToast ?? (() => {});

    this.buffer = this.createBuffer();
    this.view = this.createView(this.buffer);
    // Tree-sitter highlighting + folding for this view/buffer.
    this.syntax = new SyntaxController(this.view, this.buffer);
    // The buffer/cursor model the custom vim layer drives.
    this.editorModel = new EditorModel(this.view, this.buffer);

    // Modal editing runs through the vendored vim-mode-plus core; the window's
    // status line reads its mode via the adapter below.
    this.vimState = attachVim(this.editorModel);
    this.vim = createVimStatus(this.vimState);

    this.root = this.buildEditorArea();
    this.root.setName('TextEditor'); // selector identity for command/keymap rules

    this.installFoldKeys();
    this.followSystemColorScheme();
  }

  // --- Source view & buffer --------------------------------------------------

  private createBuffer(): SourceBuffer {
    const buffer = new GtkSource.Buffer();
    buffer.setHighlightSyntax(true);
    return buffer;
  }

  private createView(buffer: SourceBuffer): SourceView {
    const view = new GtkSource.View({ buffer });
    view.addCssClass('quilx-editor');
    view.setMonospace(true);
    view.setShowLineNumbers(true);
    view.setHighlightCurrentLine(true);
    view.setAutoIndent(true);
    view.setTabWidth(TAB_WIDTH);
    view.setShowRightMargin(true);
    view.setRightMarginPosition(RIGHT_MARGIN);
    view.setVexpand(true);
    view.setHexpand(true);
    return view;
  }

  private buildEditorArea() {
    const scrolled = new Gtk.ScrolledWindow();
    scrolled.setChild(this.view);
    scrolled.setHexpand(true);

    // The minimap mirrors the view and doubles as a scrollbar.
    const minimap = new GtkSource.Map();
    minimap.setView(this.view);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.append(scrolled);
    box.append(minimap);
    return box;
  }

  // --- Folding key bindings (vim za/zo/zc/zR/zM) -----------------------------

  private installFoldKeys() {
    // Attached to this editor's root box (an ancestor of the view) in the
    // CAPTURE phase: capture propagates toplevel→focused, so this fires before
    // the view inserts the key as text and can claim the `z` fold prefix. Gated
    // to only act while this view is focused and vim is in normal mode.
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      // hasFocus() is typed as a property in the generated bindings; the runtime
      // method exists, so call through `any`.
      if (!(this.view as any).hasFocus()) return false;
      return this.syntax.handleFoldKey(keyval, this.vimState.mode === 'normal');
    });
    this.root.addController(keys);
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    const styleManager = Adw.StyleManager.getDefault();
    const schemeManager = GtkSource.StyleSchemeManager.getDefault();
    // A theme that defines its own background owns the whole editor scheme
    // (background + line numbers); built once since it doesn't vary by system
    // light/dark. Otherwise we follow the Adwaita light/dark scheme.
    const themeScheme = theme.ui.bg ? createSourceScheme(theme) : null;
    const apply = () => {
      const scheme =
        themeScheme ?? schemeManager.getScheme(styleManager.getDark() ? 'Adwaita-dark' : 'Adwaita');
      this.buffer.setStyleScheme(scheme);
      this.syntax.restyle(); // keep tree-sitter tag colors in sync with the scheme
    };
    apply();
    styleManager.on('notify::dark', apply);
  }

  // --- File operations -------------------------------------------------------

  loadFile(path: string) {
    try {
      const content = Fs.readFileSync(path, 'utf8');
      this.buffer.setText(content, -1);
      this.buffer.placeCursor(this.buffer.getStartIter());
      // setText marks the buffer modified; the freshly-loaded content matches
      // disk, so clear the flag — `isModified()` then tracks genuine edits.
      this.buffer.setModified(false);
      this._currentFile = path;
      this.view.grabFocus();

      // Prefer tree-sitter; fall back to GtkSourceView's `.lang` engine for
      // languages we don't have a grammar for.
      const handled = this.syntax.setLanguageForPath(path);
      if (handled) {
        this.buffer.setLanguage(null); // ensure the .lang engine stays off
      } else {
        const langManager = GtkSource.LanguageManager.getDefault();
        this.buffer.setHighlightSyntax(true);
        this.buffer.setLanguage(langManager.guessLanguage(path, null));
      }
      this.emitTitleChange();
    } catch (error) {
      this.onToast(`Could not open ${Path.basename(path)}: ${(error as Error).message}`);
    }
  }

  /** Save to the current file. No-op if the editor has no file yet. */
  save() {
    if (this._currentFile) this.saveAs(this._currentFile);
  }

  saveAs(path: string) {
    const content = this.buffer.getText(
      this.buffer.getStartIter(),
      this.buffer.getEndIter(),
      false,
    );
    try {
      Fs.writeFileSync(path, content);
      this.buffer.setModified(false);
      this._currentFile = path;
      this.emitTitleChange();
      this.onToast(`Saved ${Path.basename(path)}`);
    } catch (error) {
      this.onToast(`Could not save: ${(error as Error).message}`);
    }
  }

  // --- Identity --------------------------------------------------------------

  get currentFile(): string | null {
    return this._currentFile;
  }

  /** The tab/window title for this editor (file basename, or "Untitled"). */
  get title(): string {
    return this._currentFile ? Path.basename(this._currentFile) : 'Untitled';
  }

  focus() {
    this.view.grabFocus();
  }

  // --- Session integration ---------------------------------------------------

  /** Session state for this tab, or `null` for an unsaved/empty editor. */
  serialize(): TabState | null {
    if (!this._currentFile) return null;
    const cursor = this.editorModel.getCursorBufferPosition();
    return { kind: 'file', path: this._currentFile, cursor: [cursor.row, cursor.column] };
  }

  /** Restore a saved cursor position (clamped to the buffer) and reveal it. */
  restoreCursor(cursor: [number, number]) {
    this.editorModel.setCursorBufferPosition({ row: cursor[0], column: cursor[1] });
    this.view.scrollToMark(this.buffer.getInsert(), 0, true, 0.5, 0.5);
  }

  /** True while the buffer holds unsaved edits — drives the exit prompt. */
  isModified(): boolean {
    return this.buffer.getModified();
  }

  /** Exit-prompt label, e.g. "foo.ts (unsaved)". */
  getModifiedLabel(): string {
    return `${this.title} (unsaved)`;
  }

  /** Flush unsaved edits to the current file (no-op for an untitled buffer). */
  saveModified(): void {
    this.save();
  }

  /** Subscribe to title changes (fired when the editor's file changes). */
  onTitleChange(callback: () => void) {
    this.titleHandlers.push(callback);
  }

  private emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}
