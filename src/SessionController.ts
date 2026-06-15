/*
 * SessionController — drives session save/restore/autosave for one window.
 *
 * It owns the *policy* (when to save, how to rebuild a workspace, debounced
 * autosave, the launch-restore decision) while leaving the *widget construction*
 * to the host (AppWindow) via the `createEditorTab` / `createTerminalTab`
 * callbacks. That split keeps all GTK widget wiring in AppWindow and all the
 * session bookkeeping here, so the contended window class stays thin.
 *
 * Storage and format live in `quilx.session` (SessionManager); this is the layer
 * that walks the live workbench into a `SessionState` and back. Agents are
 * recorded but not relaunched on restore (an opt-in relaunch is a later phase);
 * files whose path no longer exists are skipped and surfaced as one notification.
 */
import * as Fs from 'node:fs';
import { GLib } from './gi.ts';
import { quilx } from './quilx.ts';
import { SESSION_VERSION, type SessionState, type TabState } from './SessionManager.ts';
import type { PanelGroup, RestoredChild } from './ui/PanelGroup.ts';
import type { FileTree } from './ui/FileTree.ts';

export interface SessionDocks {
  notificationLog: boolean;
  leftSplit?: number;
}

export interface SessionControllerOptions {
  /** The workspace root this session belongs to (the window cwd). */
  root: string;
  center: PanelGroup;
  fileTree: FileTree;
  /** Serialize one tab's widget to its persistent state (`null` to skip). */
  serializeChild: Parameters<PanelGroup['serializeLayout']>[0];
  /** Build a file editor tab for restore (no panel attach); `null` to skip. */
  createEditorTab: (path: string, cursor?: [number, number]) => RestoredChild | null;
  /** Build a terminal tab for restore (no panel attach); `null` to skip. */
  createTerminalTab: (cwd: string) => RestoredChild | null;
  /** Current window-level dock state, for serialization. */
  getDocks: () => SessionDocks;
  /** Apply restored window-level dock state. */
  applyDocks: (docks: SessionDocks) => void;
}

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private autosaveTimer = 0;
  // Files skipped during the in-flight restore (no longer on disk), aggregated
  // into a single notification at the end.
  private missing: string[] = [];

  constructor(opts: SessionControllerOptions) {
    this.opts = opts;
  }

  // --- Serialize -------------------------------------------------------------

  /** Snapshot the live workbench as a session for this root. */
  serialize(): SessionState {
    return {
      version: SESSION_VERSION,
      savedAt: '', // stamped by SessionManager.save
      workspaces: [
        {
          root: this.opts.root,
          layout: this.opts.center.serializeLayout(this.opts.serializeChild),
          fileTree: { expanded: this.opts.fileTree.serializeExpanded() },
        },
      ],
      activeWorkspace: 0,
      docks: this.opts.getDocks(),
    };
  }

  /** Persist the current session now (best effort; never throws to the caller). */
  saveNow(): void {
    try {
      quilx.session.save(this.serialize());
    } catch (error) {
      console.warn(`[session] save failed: ${(error as Error).message}`);
    }
  }

  // --- Autosave --------------------------------------------------------------

  /** Schedule a debounced autosave, if `session.autosave` is enabled. */
  scheduleAutosave(): void {
    if (quilx.config.get('session.autosave') !== true) return;
    if (this.autosaveTimer) GLib.sourceRemove(this.autosaveTimer);
    const ms = Math.max(0, Number(quilx.config.get('session.autosaveDebounceMs') ?? 1000));
    this.autosaveTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, ms, () => {
      this.autosaveTimer = 0;
      this.saveNow();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Cancel any pending autosave and flush once on quit (if autosave is on). */
  flush(): void {
    if (this.autosaveTimer) {
      GLib.sourceRemove(this.autosaveTimer);
      this.autosaveTimer = 0;
    }
    if (quilx.config.get('session.autosave') === true) this.saveNow();
  }

  // --- Restore ---------------------------------------------------------------

  /**
   * Restore the saved session for this root into the workbench, replacing the
   * current layout. Returns false if there is no saved session. Missing files
   * are skipped and reported; agents are recorded-only (not relaunched yet).
   */
  restore(): boolean {
    const state = quilx.session.load(this.opts.root);
    if (!state) return false;
    const workspace = state.workspaces[state.activeWorkspace] ?? state.workspaces[0];
    if (!workspace) return false;

    this.missing = [];
    this.opts.center.restoreLayout(workspace.layout, (tab) => this.deserialize(tab));
    if (workspace.fileTree) this.opts.fileTree.restoreExpanded(workspace.fileTree.expanded);
    if (state.docks) this.opts.applyDocks(state.docks);

    if (this.missing.length > 0) {
      const n = this.missing.length;
      quilx.notifications.addWarning(`${n} file${n === 1 ? '' : 's'} could not be reopened`, {
        detail: 'They no longer exist on disk and were skipped while restoring the session.',
      });
    }
    return true;
  }

  /** Should a bare launch (no explicit file arg) restore a saved session? */
  shouldRestoreOnLaunch(): boolean {
    return quilx.config.get('session.restoreOnLaunch') === true && quilx.session.load(this.opts.root) !== null;
  }

  // Rebuild one tab. Files that vanished are skipped (and counted); terminals are
  // respawned in their cwd; agents are not relaunched here (see the phase plan).
  private deserialize(tab: TabState): RestoredChild | null {
    switch (tab.kind) {
      case 'file':
        if (!Fs.existsSync(tab.path)) {
          this.missing.push(tab.path);
          return null;
        }
        return this.opts.createEditorTab(tab.path, tab.cursor);
      case 'terminal':
        return this.opts.createTerminalTab(tab.cwd);
      case 'agent':
        return null;
    }
  }
}
