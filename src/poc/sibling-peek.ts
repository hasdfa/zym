#!/usr/bin/env node
/*
 * POC: a focusable inline peek via a SIBLING overlay (not a text-window child).
 *
 * Step 3 proved that an `add_overlay` child (a descendant of the GtkTextView) can't
 * host a focusable editor: it receives key events but letter input (IM-commit) leaks
 * to the OUTER view, because focus stays "within" the outer view's subtree (see
 * docs/text-editor/inline-widgets.md). This POC tests the fix: put the nested
 * editor in a *sibling* overlay (the editor's `Gtk.Overlay` layer, like the hover
 * card / caret), positioned at the reserved gap via buffer→window coords with
 * manual scroll-follow. A sibling is NOT a descendant, so focusing it should make
 * the outer view lose focus entirely → its IM releases → no input leak.
 *
 * The gap is still reserved with a `pixels-below-lines` tag (so real lines part);
 * only the *positioning* differs from the text-window overlay.
 *
 * Run:  node src/poc/sibling-peek.ts
 *   Ctrl+Space   toggle the peek at line 6
 *   THE TEST: click into the nested editor and type — letters must land THERE, not
 *     in the outer "file" view. Then click back into the outer view and type —
 *     letters must land in the outer view. Scroll — the peek should track its line.
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import GtkSource from 'gi:GtkSource-5';

const asIter = (res: any): any => (Array.isArray(res) ? res[1] : res);

const ANCHOR_LINE = 5; // 0-based; the peek sits below this line
const PEEK_HEIGHT = 120;
const SAMPLE = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, ' ')}  — outer "file" — type here too`).join('\n');

let view: any; // the outer "file" view
let buffer: any;
let overlay: any; // Gtk.Overlay (sibling layer host)
let gapTag: any;
let peek: any = null; // the peek card, or null when hidden

const PEEK_WIDTH = 460;

function buildEditor() {
  buffer = new GtkSource.Buffer();
  view = new GtkSource.View({ buffer });
  view.setMonospace(true);
  view.setLeftMargin(8);
  view.setTopMargin(4);
  gapTag = new Gtk.TextTag({ name: 'peek-gap' });
  buffer.getTagTable().add(gapTag);
}

/** The reserved gap's top-left in the view's WIDGET coords (scroll-aware). */
function gapWindowXY(): [number, number] {
  const iter = asIter(buffer.getIterAtLine(ANCHOR_LINE));
  const loc = view.getIterLocation(iter);
  const rect = Array.isArray(loc) ? loc[0] ?? loc[1] : loc;
  const bufX = rect?.x ?? 0;
  const bufY = (rect?.y ?? 0) + (rect?.height ?? 0); // bottom of the anchor line
  const [winX, winY] = view.bufferToWindowCoords(Gtk.TextWindowType.WIDGET, bufX, bufY);
  return [winX, winY];
}

/** Make the peek card: a bordered box holding a nested editor (the focus test). */
function makePeekCard(): any {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  card.addCssClass('peek-card');
  card.setHalign(Gtk.Align.START);
  card.setValign(Gtk.Align.START);
  card.setSizeRequest(460, PEEK_HEIGHT);

  const nested = new GtkSource.View({ buffer: new GtkSource.Buffer() });
  nested.setMonospace(true);
  nested.getBuffer().setText('// PEEK (sibling overlay) — click here and type.\n// Letters must land HERE, not in the outer file.', -1);
  const scroller = new Gtk.ScrolledWindow();
  scroller.setChild(nested);
  scroller.setVexpand(true);
  card.append(scroller);
  return card;
}

function showPeek() {
  if (peek) return;
  // 1) reserve the band so real lines part. 2) drop the card into the SIBLING
  // overlay (not the text window) and position it at the gap.
  gapTag.pixelsBelowLines = PEEK_HEIGHT;
  const start = asIter(buffer.getIterAtLine(ANCHOR_LINE));
  const end = asIter(buffer.getIterAtLine(ANCHOR_LINE + 1));
  buffer.applyTag(gapTag, start, end);

  peek = makePeekCard();
  peek.setSizeRequest(PEEK_WIDTH, PEEK_HEIGHT);
  overlay.addOverlay(peek); // a direct overlay child; positioned via get-child-position
  view.queueResize();
}

function hidePeek() {
  if (!peek) return;
  const start = asIter(buffer.getIterAtLine(ANCHOR_LINE));
  const end = asIter(buffer.getIterAtLine(ANCHOR_LINE + 1));
  buffer.removeTag(gapTag, start, end);
  gapTag.pixelsBelowLines = 0;
  overlay.removeOverlay(peek);
  peek = null;
  view.queueResize();
}

function togglePeek() {
  if (peek) hidePeek();
  else showPeek();
}

/** Re-run the overlay's allocation so get-child-position repositions the peek at the
 *  gap's current window coords (exact + unclamped, now that node-gtk #444 is fixed).
 *  Called on scroll. */
function reposition() {
  if (!peek) return;
  overlay.queueAllocate?.();
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.peek', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
 try {
  buildEditor();

  Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
  const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');
  if (scheme) buffer.setStyleScheme(scheme);

  const display = Gdk.Display.getDefault();
  if (display) {
    const css = new Gtk.CssProvider();
    css.loadFromData('.peek-card { background: #2d2d2d; border: 1px solid #3584e4; border-radius: 6px; }', -1);
    Gtk.StyleContext.addProviderForDisplay(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  }

  buffer.setText(SAMPLE, -1);
  buffer.placeCursor(buffer.getStartIter());

  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number, _code: number, state: number) => {
    if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0 && keyval === Gdk.KEY_space) { togglePeek(); return true; }
    return false;
  });
  view.addController(keys);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);
  overlay = new Gtk.Overlay();
  overlay.setChild(scrolled);

  // Scroll-follow: reposition as the outer view scrolls. IMPORTANT: read the
  // vadjustment AFTER the view is in the ScrolledWindow — the scroller swaps in its
  // own adjustment, so hooking earlier binds a dead (placeholder) one.
  scrolled.getVadjustment()?.on('value-changed', () => reposition());

  // Position the peek at the gap's exact window coords. The overlay allocates it
  // ONLY that rect, so clicks outside the card reach the file below (no full-size
  // input-blocking layer), and the rect is unclamped (can slide off at edges).
  // Needs node-gtk #444 (caller-allocated out-struct signal params).
  overlay.on('get-child-position', (child: any, alloc: any) => {
    if (child !== peek || !alloc) return false; // default position for other children
    const [winX, winY] = gapWindowXY();
    alloc.x = Math.round(winX);
    alloc.y = Math.round(winY);
    alloc.width = PEEK_WIDTH;
    alloc.height = PEEK_HEIGHT;
    return true;
  });

  // Defer the initial peek until mapped+laid-out (get_iter_location is 0 before).
  view.on('map', () => setTimeout(() => { if (!peek) showPeek(); }, 32));

  const window = new Adw.ApplicationWindow({ application: app });
  window.setTitle('zym POC — sibling-overlay peek (Ctrl+Space; type in the peek vs the file)');
  window.setDefaultSize(680, 560);
  window.setContent(overlay);
  window.on('close-request', () => { loop.quit(); app.quit(); return false; });
  window.present();
  view.grabFocus();

  loop.run();
 } catch (e) {
  process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
  loop.quit(); app.quit();
 }
});

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
