/*
 * Workspace — the app-wide entry point for opening files, exposed as
 * `quilx.workspace`. The concrete implementation lives in AppWindow (it owns the
 * center panel tree); AppWindow installs it via `setOpener` on construction. This
 * indirection lets any component (lists, panels, future plugins) open a file
 * without threading an `onOpenFile` callback through its constructor.
 *
 * The opener reveals an already-open editor for the path instead of opening a
 * duplicate tab — so "don't re-open what's already open" is the default behaviour
 * everywhere files are opened, not a per-call concern.
 */

export interface OpenFileOptions {
  /** Place the cursor at this `[row, column]` after opening/revealing. */
  cursor?: [number, number];
}

type Opener = (path: string, options?: OpenFileOptions) => void;

export class Workspace {
  private opener: Opener | null = null;

  /** Wire the concrete file opener (the AppWindow does this on construction). */
  setOpener(opener: Opener): void {
    this.opener = opener;
  }

  /**
   * Open `path`, revealing an already-open tab instead of duplicating it. No-op
   * (with a warning) until the AppWindow has registered its opener.
   */
  openFile(path: string, options?: OpenFileOptions): void {
    if (!this.opener) {
      console.warn('quilx.workspace.openFile called before an opener was registered');
      return;
    }
    this.opener(path, options);
  }
}
