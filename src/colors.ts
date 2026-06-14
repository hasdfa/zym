// Colors from the kyntell colorscheme.

export const THEME = {
  fg: '#C9D2E1', // Normal fg (s:fg)
} as const;

// Capture name → foreground color, keyed by the capture names Zed's queries emit
// (see grammar.ts). Dotted captures resolve by longest-prefix fallback in the
// highlighter (syntax-controller's resolveTag): e.g. @keyword.control/.import/
// .declaration all reuse `keyword`, @type.builtin/.class/.name reuse `type`,
// @function.method reuses `function`. Only list a dotted key to give it a
// *distinct* color (e.g. `string.escape`). Captures with no entry — @variable,
// @variable.parameter, @operator, @punctuation.*, @embedded, the @*.jsx tags —
// stay the default foreground.
//
// KEY ORDER MATTERS: one tag is created per entry in this order, and GtkTextTag
// priority follows creation order (later = higher). A node can match several
// patterns at once (Zed's catch-all `(identifier) @variable` plus a specific
// `@function`/`@constant`/…, or `@string` plus `@string.escape` over an escape),
// and all matching tags apply — priority decides the winner. So more-specific
// categories come LAST: `string.escape` after `string`, `property` before
// `function` so method names win, `type`/`constructor` after `property`.
export const COLORS: Record<string, string> = {
  comment:            '#777777', // base7
  string:             '#f9c859', // string_color  (string.regex/.special fall back here)
  'string.escape':    '#EB05AA', // special_color — escape sequences inside strings
  number:             '#da8548', // orange
  boolean:            '#da8548', // orange — true / false
  'constant.builtin': '#da8548', // orange — null / undefined
  constant:           '#a9a1e1', // violet — UPPER_CASE constants
  'variable.special': '#a9a1e1', // violet — this / super
  keyword:            '#10b1fe', // blue_main  (keyword.control/.import/.declaration fall back here)
  property:           '#ECCC7B', // yellow  (property.name falls back here)
  type:               '#e5ce5c', // yellow_main  (type.builtin/.class/.name fall back here)
  constructor:        '#e5ce5c', // yellow_main — the `constructor` method
  function:           '#DFD9A3', // fn_color  (function.method falls back here)
};
