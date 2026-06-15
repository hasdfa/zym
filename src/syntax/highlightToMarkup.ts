/*
 * highlightToMarkup — syntax-highlight a code snippet to Pango markup, reusing
 * the editor's tree-sitter grammars + highlight queries + theme colors.
 *
 * Used for LSP hover code blocks (and reusable for any read-only code preview).
 * Parses the snippet with the preloaded grammar for its language, runs the same
 * highlights query the editor uses, and emits `<span foreground=…>` runs — the
 * per-character winner is the highest-priority capture (priority = the capture's
 * color order in `theme.syntax`, mirroring how the editor's GtkTextTags resolve
 * overlaps). Returns null when there's no grammar for the language (the caller
 * then renders the code plain).
 */
import { getGrammar, createParser, type Grammar } from './grammar.ts';
import { theme } from '../theme/theme.ts';

// Fence/info-string language → quilx grammar id (we only ship typescript + tsx;
// tsx is the superset for JS/JSX). Unknown languages get no highlighting.
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  jsx: 'tsx',
  js: 'tsx',
  javascript: 'tsx',
  mjs: 'tsx',
  cjs: 'tsx',
};

// Capture-color priority order (later in theme.syntax = higher priority, matching
// the editor's GtkTextTag creation order).
const SYNTAX_KEYS = Object.keys(theme.syntax);
const colorCache = new Map<string, { color: string; priority: number } | null>();

// Resolve a capture name to a color + priority, with the standard longest-prefix
// fallback (`function.method` → `function`); null when no prefix is themed.
function colorForCapture(name: string): { color: string; priority: number } | null {
  const cached = colorCache.get(name);
  if (cached !== undefined) return cached;
  let key: string | undefined = name;
  while (key) {
    const color = (theme.syntax as Record<string, string>)[key];
    if (color) {
      const result = { color, priority: SYNTAX_KEYS.indexOf(key) };
      colorCache.set(name, result);
      return result;
    }
    const dot = key.lastIndexOf('.');
    key = dot === -1 ? undefined : key.slice(0, dot);
  }
  colorCache.set(name, null);
  return null;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Grammar for a fence/info-string language, or null if we don't have one. */
function grammarForLang(lang: string | undefined): Grammar | null {
  if (!lang) return null;
  const langId = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return getGrammar(langId);
}

/**
 * Syntax-highlight `code` (in language `lang`) to Pango markup, or null if the
 * language has no grammar. The markup contains only `<span foreground>` runs
 * (no font); the caller wraps it in the monospace face.
 */
export function highlightToMarkup(code: string, lang: string | undefined): string | null {
  const grammar = grammarForLang(lang);
  if (!grammar) return null;

  let parser: any;
  let tree: any;
  try {
    parser = createParser(grammar);
    tree = parser.parse(code);
  } catch {
    parser?.delete?.();
    return null;
  }

  // Per-character color, keeping the highest-priority capture that covers it.
  const colors: (string | null)[] = new Array(code.length).fill(null);
  const priority: number[] = new Array(code.length).fill(-1);
  for (const cap of grammar.query.captures(tree.rootNode)) {
    const resolved = colorForCapture(cap.name);
    if (!resolved) continue;
    const end = Math.min(cap.node.endIndex, code.length);
    for (let i = cap.node.startIndex; i < end; i++) {
      if (resolved.priority > priority[i]) {
        priority[i] = resolved.priority;
        colors[i] = resolved.color;
      }
    }
  }
  tree.delete?.();
  parser.delete?.();

  // Emit runs of equal color.
  let out = '';
  for (let i = 0; i < code.length; ) {
    const color = colors[i];
    let j = i + 1;
    while (j < code.length && colors[j] === color) j++;
    const segment = escapeText(code.slice(i, j));
    out += color ? `<span foreground="${color}">${segment}</span>` : segment;
    i = j;
  }
  return out;
}
