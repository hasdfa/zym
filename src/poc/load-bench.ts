#!/usr/bin/env node
/*
 * Throwaway bench (perf/text-editor-investigation): measure the synchronous
 * load-path costs that block opening a file, at representative sizes.
 *
 *   1. tree-sitter full parse        (DocumentSyntax.setLanguageForPath -> reparse{full})
 *   2. whole-buffer getText FFI      (DocumentSyntax.reparse, run on EVERY reparse)
 *   3. astral surrogate scan         (the /[\ud800-\udbff]/ test over cachedText, every reparse)
 *   4. model.setText into the buffer (Document.setText)
 *
 *   node src/poc/load-bench.ts
 */
import { createRequire } from 'node:module';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTreeSitter, loadGrammar, createParser } from '../syntax/grammar.ts';
import { languages } from '../lang/index.ts';

const pluginDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'typescript');
languages.registerLanguage({ id: 'typescript', fileTypes: ['ts', 'mts', 'cts'] });
languages.registerGrammar('typescript', {
  wasm: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  highlightsPath: Path.join(pluginDir, 'queries/typescript/highlights.scm'),
  foldTypes: ['statement_block', 'object', 'array', 'arguments', 'class_body'],
  foldsPath: Path.join(pluginDir, 'queries/typescript/folds.scm'),
});

const require_ = createRequire(import.meta.url);
const gi = require_('node-gtk') as typeof import('node-gtk');
const GtkSource = gi.require('GtkSource', '5') as any;
gi.startLoop();
const Gtk = gi.require('Gtk', '4.0') as any;
Gtk.init();

// A representative ~20-line TS block, repeated to hit a target line count.
const BLOCK = `
export class Widget {
  private items: Map<string, number> = new Map();
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  add(key: string, value: number): void {
    // accumulate into the map, replacing any prior entry
    this.items.set(key, (this.items.get(key) ?? 0) + value);
  }
  total(): number {
    let sum = 0;
    for (const [, v] of this.items) sum += v;
    return sum;
  }
  describe(): string {
    return \`\${this.name}: \${this.total()} across \${this.items.size} keys\`;
  }
}
`;

function sourceOfLines(lines: number): string {
  const blockLines = BLOCK.split('\n').length;
  const reps = Math.ceil(lines / blockLines);
  return BLOCK.repeat(reps);
}

function ms(fn: () => void, reps = 1): number {
  // warm
  fn();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = process.hrtime.bigint();
    fn();
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    if (d < best) best = d;
  }
  return best;
}

async function main() {
  await initTreeSitter();
  const grammar = await loadGrammar('typescript');
  if (!grammar) throw new Error('no typescript grammar');

  // Mirrors DocumentSyntax.INITIAL_PARSE_LINES: the synchronous first parse now reads only
  // this many lines; the rest is parsed deferred (off the open critical path).
  const INITIAL_PARSE_LINES = 500;
  const SIZES = [500, 1000, 2000, 5000, 10000, 20000, 50000];
  const pad = (s: any, n: number) => String(s).padEnd(n);
  console.log('\n=== load-bench (synchronous open-path costs, ms; min of reps) ===\n');
  console.log([pad('lines', 8), pad('bytes', 9), pad('full', 9), pad('head≤500', 10), pad('getText', 9), pad('astral', 9), pad('setText', 9)].join(''));

  for (const lines of SIZES) {
    const text = sourceOfLines(lines);
    const bytes = Buffer.byteLength(text);
    // The head the bounded first parse actually reads (first INITIAL_PARSE_LINES lines).
    const headText = text.split('\n').slice(0, INITIAL_PARSE_LINES).join('\n');

    // 1. full parse (the OLD synchronous open cost — O(file))
    const parseMs = ms(() => {
      const parser = createParser(grammar);
      const tree = parser.parse(text);
      tree.delete();
      parser.delete();
    }, 5);

    // 1b. bounded first parse (the NEW synchronous open cost — O(viewport), flat in file size)
    const headParseMs = ms(() => {
      const parser = createParser(grammar);
      const tree = parser.parse(headText);
      tree.delete();
      parser.delete();
    }, 5);

    // build a buffer holding the text for the FFI measurements
    const buf = new GtkSource.Buffer();
    buf.setText(text, -1);

    // 2. whole-buffer getText round-trip (done on every reparse)
    const getTextMs = ms(() => {
      buf.getText(buf.getStartIter(), buf.getEndIter(), true);
    }, 10);

    // 3. astral scan over cachedText (done on every reparse)
    const cached = buf.getText(buf.getStartIter(), buf.getEndIter(), true);
    const astralMs = ms(() => { /[\ud800-\udbff]/.test(cached); }, 20);

    // 4. setText into a buffer (Document.setText -> model, mirrored to each view)
    const setTextMs = ms(() => {
      const b = new GtkSource.Buffer();
      b.setText(text, -1);
    }, 5);

    console.log(
      [
        pad(lines, 8),
        pad((bytes / 1024).toFixed(0) + 'k', 9),
        pad(parseMs.toFixed(1), 9),
        pad(headParseMs.toFixed(1), 10),
        pad(getTextMs.toFixed(1), 9),
        pad(astralMs.toFixed(2), 9),
        pad(setTextMs.toFixed(1), 9),
      ].join(''),
    );
  }
  console.log('\nfull     = tree-sitter full parse — the OLD synchronous open cost (O(file))');
  console.log('head≤500 = bounded first parse — the NEW synchronous open cost (flat, deferred remainder)');
  console.log('getText + astral = paid again on EVERY 60ms-debounced reparse while typing\n');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
