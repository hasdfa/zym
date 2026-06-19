/*
 * fuzzyMatch — the picker's scoring core, kept free of any GTK imports so it can
 * be unit-tested on its own and reused by anything that needs subsequence
 * ranking.
 *
 * The scoring is a port of jhawthorn/fzy's algorithm (see its `match.c`): a
 * Smith-Waterman-style dynamic program over two matrices, with bonuses that
 * reward matches at the start of words / path segments and penalise the gaps
 * between matched characters. It produces noticeably better rankings than a
 * greedy scan for the short queries a picker sees, and reconstructs which
 * characters matched for highlighting.
 *
 * Two extensions on top of stock fzy:
 *   - `boostFrom`: a char offset (e.g. a filename's start) whose matches score
 *     higher, so filename hits outrank directory hits.
 *   - `maxTypos`: allow up to N query characters to go unmatched (a heavily
 *     penalised fallback), so a small typo still finds its target.
 *
 * Matching is case-insensitive by default, but `smartcase` (on by default)
 * makes it case-sensitive as soon as the query contains an uppercase letter —
 * the familiar editor convention where a lowercase query matches anything but
 * `Foo` only matches `Foo`.
 */

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices in the text that the query matched, in order. */
  positions: number[];
}

export interface FuzzyOptions {
  /** Char offset in `text` from which matches score higher (e.g. a filename). */
  boostFrom?: number;
  /** Max query chars allowed to go unmatched for a typo-tolerant fallback. */
  maxTypos?: number;
  /**
   * Case-sensitive when the query contains an uppercase letter, otherwise
   * case-insensitive. Defaults to `true`. Set `false` to always ignore case.
   */
  smartcase?: boolean;
}

// fzy's scoring weights (see jhawthorn/fzy match.h). Scores are small floats; a
// perfect run accrues ~1 per consecutive character, while gaps cost fractions.
const SCORE_MIN = -Infinity;
const SCORE_MAX = Infinity;
const GAP_LEADING = -0.005; // each char skipped before the first match
const GAP_TRAILING = -0.005; // each char after the last match
const GAP_INNER = -0.01; // each char skipped between two matches
const MATCH_CONSECUTIVE = 1.0; // match immediately following the previous one
const MATCH_SLASH = 0.9; // match right after a path separator
const MATCH_WORD = 0.8; // match right after a word separator (- _ space)
const MATCH_CAPITAL = 0.7; // match at a camelCase hump
const MATCH_DOT = 0.6; // match right after a dot
const BOOST_PRIMARY = 0.4; // added to matches at/after `boostFrom`
const TYPO_PENALTY = -1.0; // per unmatched query char in the typo fallback

/**
 * Score `text` against `query` as a fuzzy (subsequence) match, recording which
 * characters matched. Returns `null` when `query` cannot be matched (not a
 * subsequence, even allowing `maxTypos` skipped query chars). An empty query
 * matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, text: string, options: FuzzyOptions = {}): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  const boostFrom = options.boostFrom ?? Number.POSITIVE_INFINITY;
  const maxTypos = options.maxTypos ?? 0;
  // Smartcase (on by default): an uppercase letter in the query opts into a
  // case-sensitive match; an all-lowercase query stays case-insensitive.
  const caseSensitive = (options.smartcase ?? true) && /[A-Z]/.test(query);

  const exact = fzyMatch(query, text, boostFrom, caseSensitive);
  if (exact) return exact;
  if (maxTypos <= 0) return null;
  return approxMatch(query, text, boostFrom, maxTypos, caseSensitive);
}

/** Stock fzy: requires `query` to be a strict subsequence of `text`. */
function fzyMatch(
  query: string,
  text: string,
  boostFrom: number,
  caseSensitive: boolean,
): FuzzyMatch | null {
  const m = query.length;
  const n = text.length;
  if (m > n) return null;

  const needle = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();

  // Cheap reject + exact-length shortcut before allocating the DP matrices.
  for (let i = 0, j = 0; i < m; i++) {
    while (j < n && haystack[j] !== needle[i]) j++;
    if (j === n) return null;
    j++;
  }
  if (m === n) {
    return { score: SCORE_MAX, positions: Array.from({ length: m }, (_, i) => i) };
  }

  const bonus = precomputeBonus(text);
  const boostAt = (j: number) => (j >= boostFrom ? BOOST_PRIMARY : 0);

  // D[i][j]: best score ending with needle[i] matched at haystack[j].
  // M[i][j]: best score for needle[0..i] within haystack[0..j] (the running max).
  const D: Float64Array[] = [];
  const M: Float64Array[] = [];
  for (let i = 0; i < m; i++) {
    D.push(new Float64Array(n));
    M.push(new Float64Array(n));
  }

  for (let i = 0; i < m; i++) {
    let prevScore = SCORE_MIN;
    const gap = i === m - 1 ? GAP_TRAILING : GAP_INNER;
    const Di = D[i];
    const Mi = M[i];
    const Dp = i > 0 ? D[i - 1] : null;
    const Mp = i > 0 ? M[i - 1] : null;

    for (let j = 0; j < n; j++) {
      if (needle[i] === haystack[j]) {
        let score = SCORE_MIN;
        if (i === 0) {
          score = j * GAP_LEADING + bonus[j];
        } else if (j > 0) {
          score = Math.max(
            Mp![j - 1] + bonus[j], // start a fresh match here
            Dp![j - 1] + MATCH_CONSECUTIVE, // extend a consecutive run
          );
        }
        if (score !== SCORE_MIN) score += boostAt(j);
        Di[j] = score;
        prevScore = Math.max(score, prevScore + gap);
        Mi[j] = prevScore;
      } else {
        Di[j] = SCORE_MIN;
        prevScore = prevScore + gap;
        Mi[j] = prevScore;
      }
    }
  }

  // Walk D/M back from the end to recover the matched positions (fzy's
  // match_positions): at each needle char, take the column where the best path
  // matched, preferring the consecutive predecessor.
  const positions = new Array<number>(m);
  let matchRequired = false;
  let j = n - 1;
  for (let i = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      if (
        D[i][j] !== SCORE_MIN &&
        (matchRequired || D[i][j] === M[i][j])
      ) {
        matchRequired =
          i > 0 && j > 0 && M[i][j] === D[i - 1][j - 1] + MATCH_CONSECUTIVE + boostAt(j);
        positions[i] = j;
        j--;
        break;
      }
    }
  }

  return { score: M[m - 1][n - 1], positions };
}

/**
 * Typo-tolerant fallback: allow up to `maxTypos` query characters to be dropped
 * (an extra / mistyped char the user didn't mean), scoring the best surviving
 * subsequence and penalising each drop so exact matches always rank above it.
 */
function approxMatch(
  query: string,
  text: string,
  boostFrom: number,
  maxTypos: number,
  caseSensitive: boolean,
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (let k = 0; k < query.length; k++) {
    const reduced = query.slice(0, k) + query.slice(k + 1);
    if (reduced.length === 0) continue;
    // Dropping a query char never changes the smartcase decision the caller
    // already made, so carry `caseSensitive` through rather than re-deriving it.
    const match =
      maxTypos > 1
        ? fzyMatch(reduced, text, boostFrom, caseSensitive) ??
          approxMatch(reduced, text, boostFrom, maxTypos - 1, caseSensitive)
        : fzyMatch(reduced, text, boostFrom, caseSensitive);
    if (match && (!best || match.score > best.score)) best = match;
  }
  if (!best) return null;
  return { score: best.score + TYPO_PENALTY, positions: best.positions };
}

/** Per-position match bonus, from the character preceding each one. */
function precomputeBonus(text: string): Float64Array {
  const n = text.length;
  const bonus = new Float64Array(n);
  let prev = '/'; // treat the start of the string as a path boundary
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    bonus[i] = charBonus(prev, ch);
    prev = ch;
  }
  return bonus;
}

function charBonus(prev: string, cur: string): number {
  switch (prev) {
    case '/':
    case '\\':
      return MATCH_SLASH;
    case '-':
    case '_':
    case ' ':
    case ':': // namespace separator in command names (e.g. agent:continue)
      return MATCH_WORD;
    case '.':
      return MATCH_DOT;
  }
  // camelCase boundary: a lowercase/digit followed by an uppercase letter.
  if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)) return MATCH_CAPITAL;
  return 0;
}
