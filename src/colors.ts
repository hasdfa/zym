// Colors from the kyntell colorscheme.

export const THEME = {
  fg: '#C9D2E1', // Normal fg (s:fg)
} as const;

// Capture name → foreground color.
//
// KEY ORDER MATTERS: tags are created in this order and GtkTextTag priority
// follows creation order (later = higher). Overlapping captures resolve by
// priority, so more-specific categories come last: escape > string, and
// function/type > property (so method calls and constructors win over the bare
// property/identifier capture).
export const COLORS: Record<string, string> = {
  comment:           '#777777', // base7
  string:            '#f9c859', // string_color
  number:            '#da8548', // orange
  boolean:           '#da8548', // orange
  constant:          '#a9a1e1', // violet
  keyword:           '#10b1fe', // blue_main
  'keyword.control': '#10b1fe', // blue_main (no separate control-flow color)
  property:          '#ECCC7B', // yellow
  type:              '#e5ce5c', // yellow_main
  function:          '#DFD9A3', // fn_color
  escape:            '#EB05AA', // special_color
};
