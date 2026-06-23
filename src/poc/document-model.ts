#!/usr/bin/env node
/*
 * POC: the A2 "document-model" direction (see docs/text-editor/index.md →
 * "Document-model direction (A2)").
 *
 * Question: instead of sharing ONE GtkSource.Buffer across N views (which forces every
 * cursor/selection/decoration/fold to render identically in all of them — the
 * document-registry wall), give each view its OWN buffer and keep them in sync from a
 * headless model buffer that owns the text + undo. Then everything is native per view.
 *
 * This spike validates the three hard things before committing:
 *   (a) edit propagation stays in sync under typing / delete / undo / redo;
 *   (b) per-view folding (and tags / cursors generally) are independent across views;
 *   (c) propagation cost is acceptable.
 *
 * The buffer logic is exercised headless with assertions printed to stdout (run with
 * no args). `--gui` then opens an interactive two-view window for the visual checks:
 * type in either pane, Ctrl+Z / Ctrl+Y undo/redo via the model, Ctrl+F folds a region
 * in the FOCUSED pane only (the other pane must be unaffected).
 *
 * Run:  node src/poc/document-model.ts          # headless assertions
 *       node src/poc/document-model.ts --gui     # + interactive window
 */
import { Gtk, Gdk, Adw, GtkSource, GLib, Gio, startLoop } from '../gi.ts';

// node-gtk returns out-param iters either directly or as [ok, iter]; normalize.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

type EditKind = 'insert' | 'delete';

/**
 * The headless authority: owns the canonical text + the single undo stack. Never
 * shown. View buffers mirror it; their native undo is OFF, so undo/redo run here and
 * propagate out.
 */
class DocumentModel {
  readonly buffer: any;
  private readonly views: ViewMirror[] = [];
  // The view a currently-forwarding edit came from (it already has the edit natively,
  // so model propagation skips it). null = a model-originated edit (undo/redo) → all.
  private origin: ViewMirror | null = null;

  constructor(text: string) {
    this.buffer = new GtkSource.Buffer();
    this.buffer.setEnableUndo(true);
    this.buffer.setText(text, -1);
    // Any model change (a forwarded view edit, OR an undo/redo) → mirror to every view
    // except the one it came from. insert-text/delete-range run before the model
    // mutates, but the offset is the pre-edit offset, identical in every synced buffer.
    this.buffer.on('insert-text', (iter: any, t: string) => this.propagate('insert', iter.getOffset(), t, 0));
    this.buffer.on('delete-range', (start: any, end: any) =>
      this.propagate('delete', start.getOffset(), '', end.getOffset()),
    );
  }

  attach(view: ViewMirror): void {
    this.views.push(view);
  }

  getText(): string {
    return this.buffer.getText(this.buffer.getStartIter(), this.buffer.getEndIter(), true);
  }

  /** A native edit happened in `view`'s buffer → replay it on the model (which then
   *  mirrors it to the other views). `origin` keeps the propagation off `view`. */
  forward(view: ViewMirror, kind: EditKind, offset: number, textOrEnd: string | number): void {
    this.origin = view;
    try {
      if (kind === 'insert') {
        this.buffer.insert(iterAtOffset(this.buffer, offset), textOrEnd as string, -1);
      } else {
        this.buffer.delete(iterAtOffset(this.buffer, offset), iterAtOffset(this.buffer, textOrEnd as number));
      }
    } finally {
      this.origin = null;
    }
  }

  undo(): void {
    if (this.buffer.canUndo) this.buffer.undo();
  }
  redo(): void {
    if (this.buffer.canRedo) this.buffer.redo();
  }

  private propagate(kind: EditKind, offset: number, text: string, end: number): void {
    for (const view of this.views) {
      if (view === this.origin) continue; // it already has this edit natively
      view.applyFromModel(kind, offset, text, end);
    }
  }
}

/** One view: its own GtkSource.Buffer + View. Native edits forward to the model; model
 *  edits apply here (guarded so they don't forward back). */
class ViewMirror {
  readonly buffer: any;
  readonly view: any;
  private readonly model: DocumentModel;
  private suppress = false; // true while applying a model edit (don't re-forward)

  constructor(model: DocumentModel, text: string) {
    this.model = model;
    this.buffer = new GtkSource.Buffer();
    this.buffer.setEnableUndo(false); // undo authority is the model
    this.buffer.setText(text, -1);
    this.view = new GtkSource.View({ buffer: this.buffer, monospace: true });

    this.buffer.on('insert-text', (iter: any, t: string) => {
      if (this.suppress) return;
      this.model.forward(this, 'insert', iter.getOffset(), t);
    });
    this.buffer.on('delete-range', (start: any, end: any) => {
      if (this.suppress) return;
      this.model.forward(this, 'delete', start.getOffset(), end.getOffset());
    });
    model.attach(this);
  }

  getText(): string {
    return this.buffer.getText(this.buffer.getStartIter(), this.buffer.getEndIter(), true);
  }

  applyFromModel(kind: EditKind, offset: number, text: string, end: number): void {
    this.suppress = true;
    try {
      if (kind === 'insert') {
        this.buffer.insert(iterAtOffset(this.buffer, offset), text, -1);
      } else {
        this.buffer.delete(iterAtOffset(this.buffer, offset), iterAtOffset(this.buffer, end));
      }
    } finally {
      this.suppress = false;
    }
  }
}

// --- (a/b/c) headless assertions -------------------------------------------------

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
}

function runAssertions(): void {
  console.log('\n=== A2 document-model POC — headless assertions ===\n');
  const START = 'line one\nline two\nline three\n';
  const model = new DocumentModel(START);
  const a = new ViewMirror(model, START);
  const b = new ViewMirror(model, START);
  const synced = (label: string) =>
    check(`${label} — all buffers equal`, a.getText() === model.getText() && b.getText() === model.getText());

  console.log('(a) edit propagation:');
  // A native insert in view A (calling buffer.insert fires A's handler, exactly like typing).
  a.buffer.insert(iterAtOffset(a.buffer, 0), 'X', -1);
  synced('insert in A');
  check('  A got it + B mirrored it', a.getText().startsWith('X') && b.getText().startsWith('X'));

  // A native insert in view B at a different spot.
  b.buffer.insert(iterAtOffset(b.buffer, 5), 'YY', -1);
  synced('insert in B');

  // A native delete in view A.
  a.buffer.delete(iterAtOffset(a.buffer, 0), iterAtOffset(a.buffer, 1)); // remove the 'X'
  synced('delete in A');
  check('  X removed everywhere', !a.getText().includes('X') && !b.getText().includes('X'));

  console.log('\n(a) undo / redo (model-owned, propagates to every view):');
  const beforeUndo = model.getText();
  model.undo(); // re-inserts the 'X'
  synced('after undo');
  check('  undo reverted the delete (X back)', a.getText().includes('X') && b.getText().includes('X'));
  model.redo();
  synced('after redo');
  check('  redo re-applied', model.getText() === beforeUndo);

  console.log('\n(b) per-view independence (folds / tags / cursor):');
  // Folding hides lines via an `invisible` tag on the buffer; with separate buffers the
  // tag lives only in that view's tag table → the other view is unaffected.
  const foldA = new Gtk.TextTag({ name: 'fold', invisible: true });
  a.buffer.getTagTable().add(foldA);
  a.buffer.applyTag(foldA, iterAtOffset(a.buffer, 0), iterAtOffset(a.buffer, 4));
  check('fold tag exists in A', a.buffer.getTagTable().lookup('fold') !== null);
  check('fold tag ABSENT in B (independent tag table)', b.buffer.getTagTable().lookup('fold') === null);

  // Independent cursors: each buffer has its own insert mark.
  a.buffer.placeCursor(iterAtOffset(a.buffer, 2));
  b.buffer.placeCursor(iterAtOffset(b.buffer, 7));
  const aCur = asIter(a.buffer.getIterAtMark(a.buffer.getInsert())).getOffset();
  const bCur = asIter(b.buffer.getIterAtMark(b.buffer.getInsert())).getOffset();
  check('cursors are independent per view', aCur === 2 && bCur === 7);

  // Native per-buffer annotation API is reachable (rendering verified in the window).
  check('GtkSource.Annotation API present', typeof GtkSource.Annotation === 'function');

  console.log('\n(c) propagation cost (1000 single-char inserts → 2 mirrors):');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) a.buffer.insert(iterAtOffset(a.buffer, 0), '.', -1);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  synced('after 1000 propagated inserts');
  check(`  ${ms.toFixed(1)}ms total, ${(ms / 1000).toFixed(3)}ms/edit (budget <0.5ms/edit)`, ms / 1000 < 0.5);

  // Fuzz: random inserts/deletes in random views must never desync.
  console.log('\n(fuzz) 500 deterministic-random edits across both views:');
  let desynced = false;
  for (let i = 0; i < 500 && !desynced; i++) {
    const v = i % 2 === 0 ? a : b;
    const len = v.getText().length;
    const off = (i * 7919) % Math.max(1, len);
    if (i % 3 === 0 && len > 4) {
      const start = Math.min(off, len - 2);
      v.buffer.delete(iterAtOffset(v.buffer, start), iterAtOffset(v.buffer, start + 1));
    } else {
      v.buffer.insert(iterAtOffset(v.buffer, Math.min(off, len)), String.fromCharCode(97 + (i % 26)), -1);
    }
    desynced = a.getText() !== model.getText() || b.getText() !== model.getText();
  }
  check('500 random cross-view edits stayed in sync', !desynced);

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
}

// --- interactive two-view window (--gui) -----------------------------------------

const SAMPLE = Array.from(
  { length: 24 },
  (_, i) => `${String(i + 1).padStart(2, ' ')}  shared document line — edit me in either pane`,
).join('\n');

function runGui(): void {
  const loop = GLib.MainLoop.new(null, false);
  const app = new Adw.Application({
    applicationId: 'com.github.romgrk.zym.poc.docmodel',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
  });

  app.on('activate', () => {
    try {
      Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
      const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');

      const model = new DocumentModel(SAMPLE);
      const a = new ViewMirror(model, SAMPLE);
      const b = new ViewMirror(model, SAMPLE);
      for (const v of [a, b]) {
        v.view.setShowLineNumbers(true);
        v.view.setHighlightCurrentLine(true);
        if (scheme) v.buffer.setStyleScheme(scheme);
      }

      const foldTag = (buf: any) => {
        let t = buf.getTagTable().lookup('poc-fold');
        if (!t) {
          t = new Gtk.TextTag({ name: 'poc-fold', invisible: true });
          buf.getTagTable().add(t);
        }
        return t;
      };
      const attachKeys = (v: ViewMirror) => {
        const keys = new Gtk.EventControllerKey();
        keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
        keys.on('key-pressed', (keyval: number, _c: number, state: number) => {
          const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
          if (ctrl && keyval === Gdk.KEY_z) { model.undo(); return true; }
          if (ctrl && keyval === Gdk.KEY_y) { model.redo(); return true; }
          if (ctrl && keyval === Gdk.KEY_f) {
            const line = asIter(v.buffer.getIterAtMark(v.buffer.getInsert())).getLine();
            const start = asIter(v.buffer.getIterAtLine(line));
            const end = asIter(v.buffer.getIterAtLine(Math.min(line + 3, v.buffer.getLineCount())));
            v.buffer.applyTag(foldTag(v.buffer), start, end);
            return true;
          }
          return false;
        });
        v.view.addController(keys);
      };
      attachKeys(a);
      attachKeys(b);

      const wrap = (v: ViewMirror, title: string) => {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        const label = new Gtk.Label({ label: title });
        label.addCssClass('heading');
        box.append(label);
        const sw = new Gtk.ScrolledWindow();
        sw.setVexpand(true);
        sw.setChild(v.view);
        box.append(sw);
        return box;
      };

      const paned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
      paned.setStartChild(wrap(a, 'View A (own buffer)'));
      paned.setEndChild(wrap(b, 'View B (own buffer)'));
      paned.setPosition(440);

      const window = new Adw.ApplicationWindow({ application: app });
      window.setTitle('zym POC — A2 document-model (Ctrl+Z undo · Ctrl+Y redo · Ctrl+F fold THIS pane)');
      window.setDefaultSize(940, 560);
      window.setContent(paned);
      window.on('close-request', () => { loop.quit(); app.quit(); return false; });
      window.present();
      a.view.grabFocus();

      startLoop();
      loop.run();
    } catch (e) {
      process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
      loop.quit();
      app.quit();
    }
  });

  app.run([]);
}

// Headless assertions run first (no display needed for buffer logic).
Gtk.init();
runAssertions();

if (process.argv.includes('--gui')) {
  // node-gtk #442: defer app.run past the top-level module microtask.
  await new Promise((res) => setTimeout(res, 0));
  runGui();
} else {
  process.exit(failed === 0 ? 0 : 1);
}
