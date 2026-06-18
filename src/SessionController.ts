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
import { SESSION_VERSION, type SessionState, type TabState, type WorkspaceState } from './SessionManager.ts';
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
  /** Build a file editor tab for restore (no panel attach); `null` to skip. The
   *  restore carries the saved cursor, scroll, and any cached unsaved content. */
  createEditorTab: (
    path: string,
    restore: { cursor?: [number, number]; scroll?: number; unsavedText?: string },
  ) => RestoredChild | null;
  /** Build a terminal tab for restore (no panel attach); `null` to skip. */
  createTerminalTab: (cwd: string) => RestoredChild | null;
  /** Current window-level dock state, for serialization. */
  getDocks: () => SessionDocks;
  /** Apply restored window-level dock state. */
  applyDocks: (docks: SessionDocks) => void;
  /** Current window geometry, for serialization (omit if unavailable). */
  getWindow?: () => SessionState['window'];
  /** Apply restored window geometry. */
  applyWindow?: (window: NonNullable<SessionState['window']>) => void;
  /** The unsaved contents of currently-modified editors, cached so a restore can
   *  bring the edits back. */
  collectUnsaved?: () => { path: string; text: string }[];
  /** One `WorkspaceState` per open agent workbench (root + layout + `agent`
   *  identity), appended after the user workspace. Empty when no agents. */
  serializeAgentWorkspaces?: () => WorkspaceState[];
  /** Relaunch an agent workbench (resumed) from its saved workspace. */
  restoreAgent?: (workspace: WorkspaceState) => void;
}

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private autosaveTimer = 0;
  // Files skipped during the in-flight restore (no longer on disk), aggregated
  // into a single notification at the end.
  private missing: string[] = [];
  // The session being restored, so `deserialize` can read cached unsaved buffers.
  private restoringState: SessionState | null = null;

  constructor(opts: SessionControllerOptions) {
    this.opts = opts;
  }

  // --- Serialize -------------------------------------------------------------

  /** Snapshot the live workbench as a session for this root. */
  serialize(): SessionState {
    const user: WorkspaceState = {
      root: this.opts.root,
      layout: this.opts.center.serializeLayout(this.opts.serializeChild),
      fileTree: { expanded: this.opts.fileTree.serializeExpanded() },
    };
    // The user workspace is primary (index 0); each open agent workbench follows.
    return {
      version: SESSION_VERSION,
      savedAt: '', // stamped by SessionManager.save
      workspaces: [user, ...(this.opts.serializeAgentWorkspaces?.() ?? [])],
      activeWorkspace: 0,
      docks: this.opts.getDocks(),
      window: this.opts.getWindow?.(),
    };
  }

  /** Persist the current session now (best effort; never throws to the caller).
   *  Also caches the unsaved contents of modified editors beside the session. */
  saveNow(): void {
    try {
      const state = this.serialize();
      quilx.session.save(state);
      quilx.session.writeBuffers(state, this.opts.collectUnsaved?.() ?? []);
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
    // workspaces[0] is the primary (user) root; the rest are agent workbenches.
    const user = state.workspaces[0];
    if (!user) return false;

    this.missing = [];
    this.restoringState = state;
    this.opts.center.restoreLayout(user.layout, (tab) => this.deserialize(tab));
    if (user.fileTree) this.opts.fileTree.restoreExpanded(user.fileTree.expanded);
    if (state.docks) this.opts.applyDocks(state.docks);
    if (state.window) this.opts.applyWindow?.(state.window);

    // Relaunch the agent workbenches (resumed to their conversation/worktree). This
    // only runs on an explicit restore / opt-in launch, so re-running them is the
    // user's intent, not a surprise.
    for (const ws of state.workspaces.slice(1)) {
      if (ws.agent) this.opts.restoreAgent?.(ws);
    }
    this.restoringState = null;

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

  /** The saved window geometry for this root, without a full restore — so the host
   *  can size the window before mapping it (GTK4 ignores resize once shown). */
  loadWindow(): SessionState['window'] {
    return quilx.session.load(this.opts.root)?.window;
  }

  // Rebuild one tab. Files that vanished are skipped (and counted); terminals are
  // respawned in their cwd; agents are not relaunched here (see the phase plan).
  private deserialize(tab: TabState): RestoredChild | null {
    switch (tab.kind) {
      case 'file': {
        if (!Fs.existsSync(tab.path)) {
          this.missing.push(tab.path);
          return null;
        }
        // Restore unsaved edits from the buffer cache when this tab was dirty.
        const unsavedText =
          tab.dirty && this.restoringState
            ? quilx.session.readBuffer(this.restoringState, tab.path) ?? undefined
            : undefined;
        return this.opts.createEditorTab(tab.path, { cursor: tab.cursor, scroll: tab.scroll, unsavedText });
      }
      case 'terminal':
        return this.opts.createTerminalTab(tab.cwd);
      case 'agent':
        return null;
    }
  }
}
