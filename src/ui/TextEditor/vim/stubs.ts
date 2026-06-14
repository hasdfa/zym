/*
 * Stub managers for the vim layer.
 *
 * vim-mode-plus's VimState lazily instantiates ~15 managers; many are cosmetic
 * (cursor styling, hover overlays, flash) or belong to features not yet ported.
 * These no-op stands-in satisfy the `load()` contract so the mode/operation core
 * runs. They are replaced by real implementations as each feature lands.
 */
import type VimState from './vim-state.js';

/**
 * Renders cursor decorations by mode in Atom; here the cursor is the native
 * GtkSourceView cursor. We reuse its `refresh()` (called at the end of every
 * operation) as the reliable point to keep the cursor scrolled on screen, since
 * the vim layer moves the cursor with programmatic mark moves that don't
 * auto-scroll.
 */
export class CursorStyleManager {
  private readonly vimState: VimState;
  constructor(vimState: VimState) {
    this.vimState = vimState;
  }
  refresh(): void {
    this.vimState.editor.refreshCursorStyle();
    this.vimState.editor.scrollCursorOnscreen();
  }
}

/** A transient overlay near the cursor (count/input echo). Not yet implemented. */
export class HoverManager {
  constructor(_vimState: VimState) {}
  set(_value?: unknown): void {}
  reset(): void {}
  clearAllMarkers(): void {}
}

/** Drives the mode/count display in the status bar; wired to the window later. */
export class StatusBarManager {
  update(_mode: string, _submode: string | null): void {}
}

/** Flash highlights on operated ranges (cosmetic). Not yet implemented. */
export class FlashManager {
  constructor(_vimState: VimState) {}
  flash(_ranges?: unknown, _options?: unknown): void {}
  clearAllMarkers(): void {}
}

/**
 * Tracks "occurrence" markers (the `o`/`O` occurrence operator-modifier). Every
 * operator queries `hasMarkers()` on init, so this reports none until the
 * occurrence feature is ported. The other methods are only reached once
 * occurrence is active, so they stay inert.
 */
export class OccurrenceManager {
  constructor(_vimState: VimState) {}
  hasMarkers(): boolean {
    return false;
  }
  getMarkerAtPoint(_point: unknown): null {
    return null;
  }
  buildPattern(): null {
    return null;
  }
  select(_wise?: unknown): boolean {
    return false;
  }
  addPattern(_pattern?: unknown, _options?: unknown): void {}
  resetPatterns(): void {}
  destroyMarkers(_markers?: unknown): void {}
  saveLastPattern(_type?: unknown): void {}
}

/**
 * Tracks the sequential-paste cycle (paste, then `.`-style cycle through register
 * history). Not ported: `onExecute` reports "not a sequential paste", so paste
 * uses the plain unnamed register.
 */
export class SequentialPasteManager {
  constructor(_vimState: VimState) {}
  onInitialize(_operation: unknown): void {}
  onExecute(_operation: unknown): boolean {
    return false;
  }
  savePastedRangeForSelection(_selection: unknown, _range: unknown): void {}
}
