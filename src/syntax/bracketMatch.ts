/*
 * bracketMatch — the pure bracket-pair finder used by SyntaxController to
 * highlight the bracket under the cursor and its match. Text-based and
 * grammar-agnostic (works in any buffer), kept here so it's unit-testable
 * without GTK.
 *
 * Matching counts only the SAME bracket type (so `([)]` resolves per type) and is
 * purely textual — it does not yet skip brackets inside strings/comments (a future
 * tree-sitter refinement). A scan limit keeps an unmatched bracket in a huge
 * buffer from scanning to the end.
 */
const OPEN = '([{';
const CLOSE = ')]}';
const MATCH: Record<string, string> = {
  '(': ')', '[': ']', '{': '}',
  ')': '(', ']': '[', '}': '{',
};
const MAX_SCAN = 50_000;

/**
 * The bracket pair `[a, b]` (both UTF-16 indices into `text`) to highlight for a
 * cursor at `cursor`, or null. Priority:
 *   1. a bracket *under* the cursor, then the one just *before* it (so it lights
 *      up right after you type a closer) — returns that pair, or null if unmatched;
 *   2. otherwise the innermost pair *enclosing* the cursor, so the brackets stay
 *      highlighted while the cursor sits between them.
 */
export function findBracketPair(text: string, cursor: number): [number, number] | null {
  for (const pos of [cursor, cursor - 1]) {
    if (pos < 0 || pos >= text.length) continue;
    const ch = text[pos];
    if (OPEN.includes(ch)) {
      const m = scan(text, pos, ch, MATCH[ch], 1);
      return m === null ? null : [pos, m];
    }
    if (CLOSE.includes(ch)) {
      const m = scan(text, pos, ch, MATCH[ch], -1);
      return m === null ? null : [pos, m];
    }
  }
  return findEnclosingPair(text, cursor);
}

/**
 * The innermost bracket pair enclosing `cursor`: scan left for the nearest
 * *unmatched* opener (an opener whose closer is to the right of the cursor),
 * then forward for its match. Per-type counters skip already-balanced pairs.
 */
function findEnclosingPair(text: string, cursor: number): [number, number] | null {
  const pending: Record<string, number> = {}; // opener char → closers seen to its right
  const limit = Math.max(0, cursor - MAX_SCAN);
  for (let i = cursor - 1; i >= limit; i--) {
    const ch = text[i];
    if (CLOSE.includes(ch)) {
      const opener = MATCH[ch];
      pending[opener] = (pending[opener] ?? 0) + 1;
    } else if (OPEN.includes(ch)) {
      if ((pending[ch] ?? 0) > 0) pending[ch]--; // matched by a closer we passed
      else {
        const m = scan(text, i, ch, MATCH[ch], 1); // unmatched to the left → enclosing
        return m === null ? null : [i, m];
      }
    }
  }
  return null;
}

/** Scan from `from` in `dir`, balancing `same`/`other`, to the match (depth 0). */
function scan(text: string, from: number, same: string, other: string, dir: 1 | -1): number | null {
  let depth = 1;
  const limit = dir === 1 ? Math.min(text.length, from + MAX_SCAN) : Math.max(-1, from - MAX_SCAN);
  for (let i = from + dir; i !== limit; i += dir) {
    const c = text[i];
    if (c === same) depth++;
    else if (c === other) { depth--; if (depth === 0) return i; }
  }
  return null;
}
