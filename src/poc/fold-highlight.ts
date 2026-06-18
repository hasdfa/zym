#!/usr/bin/env node
/*
 * POC: tree-sitter-driven highlighting + code folding on GtkSourceView 5.
 *
 * This is a throwaway experiment, separate from the real editor, that validates
 * the two things GtkSourceView does NOT give us out of the box:
 *
 *   1. HIGHLIGHTING from tree-sitter instead of the built-in `.lang` engine.
 *      We call `setHighlightSyntax(false)`, parse the buffer with web-tree-sitter,
 *      run a highlights query, and apply our own GtkTextTags by range.
 *
 *   2. FOLDING, which has no API in GtkSource 5 at all. We derive foldable
 *      ranges from the syntax tree, draw clickable chevrons with a custom
 *      GtkSource.GutterRenderer subclass, and collapse a range by applying a
 *      TextTag with `invisible = true` over the body lines.
 *
 * The open question this answers: does GtkTextView's `invisible` tag actually
 * hide lines, and can node-gtk subclass a GtkSource gutter renderer with working
 * vfuncs? Run it and find out:
 *
 *   pnpm poc          (or: node src/poc/fold-highlight.ts [file.js])
 *
 * Click a ▾/▸ chevron in the left gutter to fold/unfold.
 */
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import * as Fs from 'node:fs';

const require_ = createRequire(import.meta.url);

// web-tree-sitter 0.20.x is CommonJS (`export = Parser`) and matches the ABI of
// the prebuilt tree-sitter-wasms grammars. Parser is the default export; the
// Language class hangs off it, and queries are built via `language.query(...)`.
const Parser = require_('web-tree-sitter') as any;
type TSNode = any;

// node-gtk is a CJS native addon; load it through createRequire from this ESM.
const gi = require_('node-gtk') as typeof import('node-gtk');
const GLib = gi.require('GLib', '2.0');
const Gdk = gi.require('Gdk', '4.0');
const Gtk = gi.require('Gtk', '4.0');
const Adw = gi.require('Adw', '1');
const GtkSource = gi.require('GtkSource', '5');

// ---------------------------------------------------------------------------
// tree-sitter setup (web-tree-sitter / wasm)
// ---------------------------------------------------------------------------

const WTS_DIR = Path.dirname(require_.resolve('web-tree-sitter'));
const JS_GRAMMAR = require_.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm');

// `locateFile` points the emscripten runtime at tree-sitter.wasm next to the js.
await Parser.init({ locateFile: (name: string) => Path.join(WTS_DIR, name) });
const jsLang = await Parser.Language.load(JS_GRAMMAR);
const parser = new Parser();
parser.setLanguage(jsLang);

// A compact JS highlights query. Capture names map to colors below. Kept to
// node types known to exist in tree-sitter-javascript so the query compiles.
const HIGHLIGHTS = `
(comment) @comment
(string) @string
(template_string) @string
(regex) @string
(number) @number
[
  "const" "let" "var" "function" "return" "if" "else" "for" "while" "do"
  "switch" "case" "break" "continue" "new" "class" "extends" "import" "export"
  "from" "default" "async" "await" "yield" "typeof" "instanceof" "throw"
  "try" "catch" "finally"
] @keyword
(function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (property_identifier) @function))
(property_identifier) @property
(true) @constant
(false) @constant
(null) @constant
`;
const query = jsLang.query(HIGHLIGHTS);

// capture name -> foreground color (VS Code "Dark+"-ish)
const COLORS: Record<string, string> = {
  comment: '#6a9955',
  string: '#ce9178',
  number: '#b5cea8',
  keyword: '#569cd6',
  function: '#dcdcaa',
  property: '#9cdcfe',
  constant: '#569cd6',
};

// Node types that make sense to fold when they span multiple lines.
const FOLD_TYPES = new Set([
  'statement_block', 'object', 'array', 'class_body',
  'switch_body', 'named_imports', 'arguments',
]);

// ---------------------------------------------------------------------------
// Fold model: foldable regions keyed by the header line they live on.
// ---------------------------------------------------------------------------

interface FoldRegion {
  startLine: number; // line where the block opens (stays visible)
  endLine: number;   // line where the block closes (stays visible)
  folded: boolean;
}

const foldsByHeaderLine = new Map<number, FoldRegion>();

// ---------------------------------------------------------------------------
// GTK widgets.
//
// IMPORTANT: these are constructed inside `activate` (see buildEditor), not at
// module top-level. node-gtk segfaults if a vfunc-overriding subclass (our
// FoldRenderer) is instantiated before the GApplication is running, so we build
// the whole widget tree only once `app.run()` has started.
// ---------------------------------------------------------------------------

let buffer: any;
let view: any;
let invisibleTag: any;
const highlightTags = new Map<string, any>();

function buildEditor() {
  buffer = new GtkSource.Buffer();
  buffer.setHighlightSyntax(false); // we drive highlighting ourselves

  view = new GtkSource.View({ buffer });
  view.setMonospace(true);
  view.setShowLineNumbers(true);
  view.setHighlightCurrentLine(true);
  view.setTabWidth(2);
  view.setVexpand(true);
  view.setHexpand(true);

  // One TextTag per capture color, created once and added to the tag table.
  for (const [name, color] of Object.entries(COLORS)) {
    const tag = new Gtk.TextTag({ name: `hl:${name}`, foreground: color });
    buffer.getTagTable().add(tag);
    highlightTags.set(name, tag);
  }

  // The single tag that performs the actual hiding when folded.
  invisibleTag = new Gtk.TextTag({ name: 'fold-hidden', invisible: true });
  buffer.getTagTable().add(invisibleTag);

  // The custom fold-chevron renderer (instantiated here, after app start).
  const foldRenderer = new FoldRenderer();
  foldRenderer.setXpad(4);
  view.getGutter(Gtk.TextWindowType.LEFT).insert(foldRenderer, 0);

  // Keyboard: Ctrl+Space toggles the innermost fold at the cursor. (A bare `za`
  // can't work here because this view is non-modal — it would just type "za".)
  const keys = new Gtk.EventControllerKey();
  // node-gtk drops the emitter arg: key-pressed → (keyval, keycode, state).
  keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    if (ctrl && keyval === Gdk.KEY_space) {
      toggleFoldAtCursor();
      return true; // handled — don't insert a character
    }
    return false;
  });
  view.addController(keys);
}

// ---------------------------------------------------------------------------
// Highlighting + fold-region discovery (re-run on every buffer change)
// ---------------------------------------------------------------------------

function fullText(): string {
  // include_hidden_chars = true so folded (invisible) text still reaches the parser.
  return buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true);
}

// node-gtk returns `[inRange, iter]` for the get_iter_at_* family (they carry a
// gboolean return), but a bare iter for get_start/end_iter. Normalize to an iter.
function asIter(r: any) {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

function iterAt(line: number, col: number) {
  // NOTE: tree-sitter columns are code-unit offsets; GtkTextBuffer wants
  // character offsets. Equal for ASCII (this POC's sample); a real impl would
  // map through byte/char offsets for non-ASCII.
  return asIter(buffer.getIterAtLineOffset(line, col));
}

function refresh() {
  const tree = parser.parse(fullText());
  if (!tree) return;
  const root = tree.rootNode;

  // --- highlighting: clear our tags, then re-apply from the query ---
  const start = buffer.getStartIter();
  const end = buffer.getEndIter();
  for (const tag of highlightTags.values()) buffer.removeTag(tag, start, end);

  for (const cap of query.captures(root)) {
    const tag = highlightTags.get(cap.name);
    if (!tag) continue;
    const n = cap.node;
    buffer.applyTag(tag, iterAt(n.startPosition.row, n.startPosition.column),
                         iterAt(n.endPosition.row, n.endPosition.column));
  }

  // --- fold regions: drop hidden state, recompute headers from the tree ---
  buffer.removeTag(invisibleTag, start, end);
  foldsByHeaderLine.clear();
  walkFolds(root);

  lastCaptureCount = query.captures(root).length;
  view.queueDraw(); // repaint gutter chevrons
}

let lastCaptureCount = 0;

function walkFolds(node: TSNode) {
  if (FOLD_TYPES.has(node.type)) {
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    // need at least one fully-hidden line between header and footer
    if (endLine - startLine >= 2 && !foldsByHeaderLine.has(startLine)) {
      foldsByHeaderLine.set(startLine, { startLine, endLine, folded: false });
    }
  }
  for (const child of node.namedChildren) if (child) walkFolds(child);
}

// ---------------------------------------------------------------------------
// Folding: collapse/expand by toggling the invisible tag over body lines.
// ---------------------------------------------------------------------------

function toggleFold(region: FoldRegion) {
  const bodyStart = asIter(buffer.getIterAtLine(region.startLine + 1)); // first body line
  const bodyEnd = asIter(buffer.getIterAtLine(region.endLine));         // footer line start

  if (region.folded) {
    buffer.removeTag(invisibleTag, bodyStart, bodyEnd);
  } else {
    buffer.applyTag(invisibleTag, bodyStart, bodyEnd);
    // Keep the cursor out of the hidden range (the known GtkTextView caveat).
    const cursor = asIter(buffer.getIterAtMark(buffer.getInsert()));
    if (cursor.getLine() > region.startLine && cursor.getLine() < region.endLine) {
      buffer.placeCursor(asIter(buffer.getIterAtLine(region.startLine)));
    }
  }
  region.folded = !region.folded;
  view.queueDraw();
}

// The innermost fold region containing the cursor line (vim's `za` target).
function regionAtCursor(): FoldRegion | null {
  const line = asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  let best: FoldRegion | null = null;
  for (const region of foldsByHeaderLine.values()) {
    if (line >= region.startLine && line <= region.endLine) {
      if (!best || region.startLine > best.startLine) best = region;
    }
  }
  return best;
}

function toggleFoldAtCursor() {
  const region = regionAtCursor();
  if (region) toggleFold(region);
}

// ---------------------------------------------------------------------------
// Custom gutter renderer: draws a ▾ / ▸ chevron on foldable header lines and
// makes those cells clickable. Subclassing GutterRendererText lets the base
// class handle text measurement/snapshot; we only override the vfuncs.
// ---------------------------------------------------------------------------

class FoldRenderer extends GtkSource.GutterRendererText {
  // Called per line before drawing: set the glyph for this line.
  queryData(_lines: any, line: number) {
    const region = foldsByHeaderLine.get(line);
    if (region) {
      this.setMarkup(region.folded ? '▸' : '▾', -1);
    } else {
      this.setMarkup(' ', -1); // reserve a stable column width
    }
  }

  // Only fold-header lines respond to clicks.
  queryActivatable(iter: any, _area: any) {
    return foldsByHeaderLine.has(iter.getLine());
  }

  // Click handler: toggle the fold on this line.
  // @ts-expect-error - overriding the activate vfunc; the base class also
  // exposes a no-arg activate() action method, so the signatures don't unify.
  activate(iter: any, _area: any, _button: number, _state: any, _nPresses: number) {
    const region = foldsByHeaderLine.get(iter.getLine());
    if (region) toggleFold(region);
  }
}
gi.registerClass(FoldRenderer);

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const SAMPLE = `// tree-sitter highlighting + folding POC
import { readFile } from 'node:fs/promises';

const CONFIG = {
  name: 'quilx',
  version: '0.1.0',
  features: ['highlight', 'fold'],
};

async function loadDocument(path) {
  const text = await readFile(path, 'utf8');
  if (text.length === 0) {
    throw new Error('empty file');
  }
  return {
    path,
    text,
    lines: text.split('\\n'),
  };
}

class Editor {
  constructor(config) {
    this.config = config;
    this.documents = new Map();
  }

  open(path) {
    const doc = loadDocument(path);
    this.documents.set(path, doc);
    return doc;
  }
}

const editor = new Editor(CONFIG);
console.log('ready', editor);
`;

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.quilx.poc' });

app.on('activate', () => {
  buildEditor(); // construct widgets now that the application is running

  Adw.StyleManager.getDefault().setColorScheme(Adw.ColorScheme.FORCE_DARK);
  const scheme = GtkSource.StyleSchemeManager.getDefault().getScheme('Adwaita-dark');
  if (scheme) buffer.setStyleScheme(scheme);

  const arg = process.argv[2];
  const text = arg ? Fs.readFileSync(Path.resolve(arg), 'utf8') : SAMPLE;
  buffer.setText(text, -1);
  buffer.placeCursor(buffer.getStartIter());

  // Re-highlight + recompute folds on every edit. (Tag changes don't emit
  // 'changed', so this doesn't recurse.)
  buffer.on('changed', () => refresh());
  refresh();

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(view);

  const window = new Adw.ApplicationWindow({ application: app });
  window.setTitle('quilx POC — Ctrl+Space folds at cursor (or click ▾/▸)');
  window.setDefaultSize(720, 640);
  window.setContent(scrolled);
  window.on('close-request', () => { loop.quit(); app.quit(); return false; });
  window.present();
  view.grabFocus();

  // Headless verification hook: measure the view's natural height before and
  // after folding everything. If the `invisible` tag really hides lines, the
  // rendered height must shrink. Prints PASS/FAIL and quits.
  if (process.env.POC_VERIFY) {
    const natHeight = () => view.measure(Gtk.Orientation.VERTICAL, -1)[1];
    setTimeout(() => {
      const before = natHeight();
      const regions = foldsByHeaderLine.size;

      // Exercise the keyboard path: park the cursor inside the first region and
      // run the same handler Ctrl+Space invokes. (Headless can't inject keys.)
      const first = [...foldsByHeaderLine.values()][0];
      buffer.placeCursor(asIter(buffer.getIterAtLine(first.startLine + 1)));
      toggleFoldAtCursor();
      const cursorTogglePicked = first.folded;
      if (first.folded) toggleFold(first); // restore before folding everything

      for (const region of foldsByHeaderLine.values()) if (!region.folded) toggleFold(region);
      setTimeout(() => {
        const after = natHeight();
        console.log(JSON.stringify({
          highlightCaptures: lastCaptureCount,
          foldRegions: regions,
          cursorToggle: cursorTogglePicked ? 'PASS (folded region at cursor)' : 'FAIL',
          heightBefore: before,
          heightAfter: after,
          folding: after < before ? 'PASS (height shrank → lines hidden)' : 'FAIL',
        }, null, 2));
        loop.quit(); app.quit();
      }, 600);
    }, 600);
  }

  gi.startLoop();
  loop.run();
});

process.exit(app.run([]));
