#!/usr/bin/env node
/*
 * Demo / construction harness for the see-definition inline peek. Builds a real
 * buffer-only TextEditor with sample code, then shows a definition peek below the
 * cursor (via editor.showPeek + buildDefinitionPeek) — exercising the InlinePeek
 * sibling-overlay path inside a real editor (caret/hover/search overlay children,
 * the get-child-position handler, the nested editor). Needs node-gtk #444.
 *
 *   node scripts/peek-demo.ts          (Ctrl+Space toggles the peek)
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { registerBundledFonts } from '../src/fonts.ts';
import { installStyles } from '../src/styles.ts';
import { preloadGrammars } from '../src/syntax/grammar.ts';
import { TextEditor } from '../src/ui/TextEditor/TextEditor.ts';
import { buildDefinitionPeek } from '../src/ui/TextEditor/buildDefinitionPeek.ts';

const SAMPLE = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i} + someValue(${i});`).join('\n');
const DEF_FILE = `export function someValue(n: number): number {\n  const doubled = n * 2;\n  if (doubled > 10) return doubled - 1;\n  return doubled;\n}\n`;

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'dev.zym.peekdemo', flags: Gio.ApplicationFlags.NON_UNIQUE });

let editor: TextEditor;

function togglePeek() {
  if (editor.peekOpen) { editor.closePeek(); return; }
  const target = { path: '/tmp/sample.ts', point: { row: 0, column: 16 } };
  const { widget, height } = buildDefinitionPeek(target, DEF_FILE, () => editor.closePeek());
  editor.showPeek({ widget, height });
}

app.on('activate', () => {
  registerBundledFonts();
  installStyles();

  editor = new TextEditor({ buffer: { initialText: SAMPLE, languagePath: 'sample.ts' } });

  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number, _c: number, state: number) => {
    if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0 && keyval === Gdk.KEY_space) { togglePeek(); return true; }
    return false;
  });
  editor.sourceView.addController(keys);

  const win = new Adw.ApplicationWindow({ application: app, defaultWidth: 800, defaultHeight: 600 });
  win.setContent(editor.root);
  win.on('close-request', () => { loop.quit(); app.quit(); return false; });
  win.present();

  // Show a peek shortly after the view is laid out (geometry must be valid).
  GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 200, () => { togglePeek(); return false; });

  loop.run();
});

await preloadGrammars();
app.run([]);
