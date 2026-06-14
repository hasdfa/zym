import { Gdk, Gtk } from './gi.ts';

const pending: string[] = [];

/** Queue a CSS string for installation. Safe to call at module init time. */
export function addStyles(css: string): void {
  pending.push(css);
}

/** Install all queued CSS into the default display. Call once after activation. */
export function installStyles(): void {
  const display = Gdk.Display.getDefault();
  if (!display) return;
  for (const css of pending) {
    const provider = new Gtk.CssProvider();
    provider.loadFromString(css);
    Gtk.StyleContext.addProviderForDisplay(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  }
  pending.length = 0;
}
