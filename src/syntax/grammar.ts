/*
 * Tree-sitter grammar registry and loader.
 *
 * Owns the one-time web-tree-sitter runtime init and a small table mapping
 * language ids (and file extensions) to a grammar wasm, a highlights query, and
 * the node types worth folding. Grammars are loaded lazily and cached.
 *
 * web-tree-sitter is pinned to 0.20.x: it's CommonJS (`export = Parser`, so the
 * Language class hangs off Parser and queries are built with `language.query`),
 * and its ABI matches the prebuilt tree-sitter-wasms grammars. See
 * memory: node-gtk-vfunc-constraints / treesitter-highlight-fold-findings.
 */
import { createRequire } from 'node:module';
import * as Path from 'node:path';

const require_ = createRequire(import.meta.url);
const Parser = require_('web-tree-sitter') as any;

let initPromise: Promise<void> | null = null;

/** Initialize the web-tree-sitter runtime exactly once. */
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    const dir = Path.dirname(require_.resolve('web-tree-sitter'));
    initPromise = Parser.init({ locateFile: (name: string) => Path.join(dir, name) }) as Promise<void>;
  }
  return initPromise!;
}

/** A loaded grammar: the parser language, its highlights query, fold node types. */
export interface Grammar {
  language: any;
  query: any;
  foldTypes: Set<string>;
}

interface GrammarSpec {
  wasm: string;          // resolvable module path to the grammar .wasm
  extensions: string[];  // file extensions that select this grammar
  highlights: string;    // tree-sitter highlights query (capture names → styles)
  foldTypes: string[];   // node types that fold when they span >1 line
}

// A compact JS highlights query. Capture names map to GtkSource style ids in
// the highlighter. Kept to node types that exist in tree-sitter-javascript so
// the query compiles cleanly.
const JS_HIGHLIGHTS = `
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

const JS_FOLD_TYPES = [
  'statement_block', 'object', 'array', 'class_body', 'switch_body',
  'named_imports', 'arguments',
];

const SPECS: Record<string, GrammarSpec> = {
  javascript: {
    wasm: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    highlights: JS_HIGHLIGHTS,
    foldTypes: JS_FOLD_TYPES,
  },
};

/** Map a file path to a known language id, or null if unsupported. */
export function langIdForPath(path: string): string | null {
  const ext = Path.extname(path).toLowerCase();
  for (const [id, spec] of Object.entries(SPECS)) {
    if (spec.extensions.includes(ext)) return id;
  }
  return null;
}

const cache = new Map<string, Grammar>();

/** Load (and cache) a grammar by language id, or null if unknown. */
export async function loadGrammar(langId: string): Promise<Grammar | null> {
  const spec = SPECS[langId];
  if (!spec) return null;
  const cached = cache.get(langId);
  if (cached) return cached;

  await initTreeSitter();
  const language = await Parser.Language.load(require_.resolve(spec.wasm));
  const grammar: Grammar = {
    language,
    query: language.query(spec.highlights),
    foldTypes: new Set(spec.foldTypes),
  };
  cache.set(langId, grammar);
  return grammar;
}

/** Synchronously get an already-loaded grammar, or null if not preloaded. */
export function getGrammar(langId: string): Grammar | null {
  return cache.get(langId) ?? null;
}

/**
 * Load the runtime and every known grammar up front. Must be awaited BEFORE the
 * GLib main loop starts: emscripten's async wasm init does not resolve once the
 * loop is running, so grammars are loaded here and used synchronously after.
 */
export async function preloadGrammars(): Promise<void> {
  await initTreeSitter();
  for (const id of Object.keys(SPECS)) await loadGrammar(id);
}

/** Create a fresh parser bound to a grammar's language. */
export function createParser(grammar: Grammar): any {
  const parser = new Parser();
  parser.setLanguage(grammar.language);
  return parser;
}
