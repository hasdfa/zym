/*
 * clipboard — a synchronous text view onto the GTK (system) clipboard.
 *
 * The register manager reads and writes the clipboard synchronously
 * (`clipboard.read()` / `clipboard.write()`), but GTK4's `Gdk.Clipboard` only
 * exposes an *async* text read. We bridge the two by writing through to the
 * system clipboard immediately and keeping a cache that is refreshed
 * asynchronously whenever the clipboard changes (including our own writes). A
 * read returns the cache — the last value we observed — which is exact right
 * after our own write and best-effort for changes made by other applications.
 *
 * With no display (headless test runs) this degrades to a plain in-memory
 * clipboard.
 */
import { Gdk, GObject } from '../../../gi.ts';

// node-gtk's generated types omit a few GTK4 clipboard members that exist at
// runtime (Display.getClipboard, GObject.TYPE_STRING) — reach them through
// `any`, the same escape hatch the rest of the codebase uses for such gaps.
/* eslint-disable @typescript-eslint/no-explicit-any */

let gtkClipboard: any = null;
let initialized = false;
let cache = '';

function ensure(): any {
  if (initialized) return gtkClipboard;
  initialized = true;
  const display = Gdk.Display.getDefault() as any;
  if (!display) return null; // headless: in-memory only
  gtkClipboard = display.getClipboard();
  gtkClipboard.on('changed', refreshCache);
  refreshCache(); // prime from whatever is already on the clipboard
  return gtkClipboard;
}

function refreshCache(): void {
  const cb = gtkClipboard;
  if (!cb) return;
  // Needs the GLib main loop spinning (true in the running app) to complete.
  cb.readTextAsync(null, (_src: unknown, result: unknown) => {
    try {
      const text = cb.readTextFinish(result);
      if (text != null) cache = text;
    } catch {
      // Empty clipboard or non-text content — keep the last known text.
    }
  });
}

export const clipboard = {
  read(): string {
    ensure();
    return cache;
  },

  write(text: string): void {
    cache = text; // write-through, so an immediate read is exact
    const cb = ensure();
    if (!cb) return;
    const value = new GObject.Value();
    value.init((GObject as any).TYPE_STRING);
    value.setString(text);
    cb.setContent(Gdk.ContentProvider.newForValue(value));
  },
};

export default clipboard;
