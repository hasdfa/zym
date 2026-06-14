// Colors from the kyntell colorscheme.

export const THEME = {
  fg: '#C9D2E1', // Normal fg (s:fg)
} as const;

// tree-sitter capture name → foreground color, keyed by the standard capture
// names the vendored grammar-own queries emit (see grammar.ts). Dotted captures
// resolve by longest-prefix fallback in the highlighter (syntax-controller's
// resolveTag), so e.g. @function.method/@function.builtin reuse `function` and
// @type.builtin reuses `type` — only list a dotted key here to give it a *distinct*
// color. Captures with no entry (e.g. @variable, @operator, @punctuation.*) stay
// the default foreground.
//
// KEY ORDER MATTERS: one tag is created per entry in this order, and GtkTextTag
// priority follows creation order (later = higher). The same identifier can be
// captured by several patterns at once (the query has a catch-all
// `(identifier) @variable` plus specific `@function`/`@constant`/…), and all
// matching tags get applied — priority decides the winner. So the more-specific
// categories must come LAST: `property` before `function` so method names win,
// `type`/`constructor` after `property`, `function` last.
export const COLORS: Record<string, string> = {
  comment:            '#777777', // base7
  string:             '#f9c859', // string_color  (string.special/regex falls back here)
  number:             '#da8548', // orange
  'constant.builtin': '#da8548', // orange — true / false / null / undefined
  constant:           '#a9a1e1', // violet — UPPER_CASE constants
  'variable.builtin': '#a9a1e1', // violet — this / super / arguments / globals
  keyword:            '#10b1fe', // blue_main
  property:           '#ECCC7B', // yellow
  type:               '#e5ce5c', // yellow_main  (type.builtin falls back here)
  constructor:        '#e5ce5c', // yellow_main — PascalCase / new-expression names
  function:           '#DFD9A3', // fn_color  (function.method/function.builtin fall back here)
};
