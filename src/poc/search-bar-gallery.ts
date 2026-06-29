#!/usr/bin/env node
/*
 * POC: the real TextEditor SearchBar in three states (matches / no-results /
 * bad-pattern), stacked, so the inset count + warning treatment + flush option
 * buttons can be eyeballed WITHOUT launching the whole app. It mounts the
 * production `src/ui/TextEditor/SearchBar.ts` verbatim over real GtkSource views.
 *
 * Run:  node --import node-gtk/register src/poc/search-bar-gallery.ts
 *   (or set POC_SHOT=/path.png to render-to-PNG and exit, for headless capture.)
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import Adw from 'gi:Adw-1';
import { installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { EditorModel } from '../ui/TextEditor/EditorModel.ts';
import { TextDecorations } from '../ui/TextEditor/TextDecorations.ts';
import { SearchController } from '../ui/TextEditor/SearchController.ts';
import { SearchBar } from '../ui/TextEditor/SearchBar.ts';
import { Point } from '../text/Point.ts';

const SAMPLE = 'const foo = 1;\nconst foobar = 2;\nconst baz = foo + foobar;\n';

/** A single overlay (editor + floating SearchBar), driven to a chosen state. */
function makeCell(caption: string, drive: (bar: SearchBar, search: SearchController) => void): InstanceType<typeof Gtk.Box> {
  const buffer = new GtkSource.Buffer();
  buffer.setText(SAMPLE, -1);
  const view = new GtkSource.View({ buffer });
  const editor = new EditorModel(view, buffer);
  editor.setCursorBufferPosition(new Point(0, 0));
  const search = new SearchController(editor, new TextDecorations(editor));

  const overlay = new Gtk.Overlay();
  overlay.setChild(view);
  overlay.setSizeRequest(720, 96);
  const bar = new SearchBar(overlay, search, view);
  drive(bar, search);

  const label = new Gtk.Label({ label: caption, xalign: 0 });
  label.addCssClass('dim-label');
  label.setMarginStart(6);
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
  box.setMarginTop(10);
  box.setMarginBottom(10);
  box.setMarginStart(10);
  box.setMarginEnd(10);
  box.append(label);
  box.append(overlay);
  return box;
}

function setQuery(bar: SearchBar, query: string, { regex = false, caseMode = '' } = {}): void {
  bar.open();
  const b = bar as any;
  if (regex) b.regexToggle.setActive(true);
  if (caseMode) { b.controller.setOptions({ caseMode }); b.refreshCaseButton(); }
  b.searchEntry.setText(query);
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.searchbar', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    const stack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    stack.setName('PocSearchStack');
    stack.append(makeCell('matches — case Aa (smart)', (bar) => setQuery(bar, 'foo', { caseMode: 'smart' })));
    stack.append(makeCell('no results — case AA (sensitive)', (bar) => setQuery(bar, 'zzzzz', { caseMode: 'sensitive' })));
    stack.append(makeCell('bad pattern — case aa (insensitive)', (bar) => setQuery(bar, '[', { regex: true, caseMode: 'insensitive' })));

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — SearchBar');
    window.setDefaultSize(760, 380);
    window.setContent(stack);
    window.on('close-request', () => { loop.quit(); app.quit(); return false; });
    window.present();

    const out = process.env.POC_SHOT;
    if (out) {
      GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 600, () => {
        const w = window.getWidth() || 760;
        const h = window.getHeight() || 380;
        const paintable = Gtk.WidgetPaintable.new(window);
        const snapshot = Gtk.Snapshot.new();
        paintable.snapshot(snapshot, w, h);
        const node = snapshot.toNode();
        const renderer = window.getRenderer();
        if (node && renderer) {
          renderer.renderTexture(node, null).saveToPng(out);
          process.stderr.write(`[POC] wrote ${out} (${w}x${h})\n`);
        }
        loop.quit();
        app.quit();
        return GLib.SOURCE_REMOVE;
      });
    }

    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

// node-gtk #442: defer app.run past the top-level module microtask.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
