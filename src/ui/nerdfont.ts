/*
 * nerdfont.ts — curated Nerd Font glyph catalog, grouped by purpose.
 *
 * Each value is the literal glyph from the bundled "Symbols Nerd Font Mono"
 * (see fonts.ts), so it renders monochrome and follows the theme foreground.
 * Use these glyphs as label text; render with `iconLabel` from icons.ts.
 *
 * Keys are descriptive (not the upstream nf-* names); the trailing comment keeps
 * the codepoint and original Nerd Font name for greppability. Curated, not
 * exhaustive — add what you need. Bulk file-tree icons live in fileIcons.ts.
 */

export const NERDFONT = {
  STATUS: {
    INFO:    '', // U+F05A nf-fa-info_circle
    SUCCESS: '', // U+F058 nf-fa-check_circle
    WARNING: '', // U+F071 nf-fa-exclamation_triangle
    ERROR:   '', // U+F06A nf-fa-exclamation_circle
    FATAL:   '', // U+F057 nf-fa-times_circle
    HINT:    '', // U+F0EB nf-fa-lightbulb_o
    BUG:     '', // U+F188 nf-fa-bug
    CHECK:   '', // U+F00C nf-fa-check
    CROSS:   '', // U+F467 nf-oct-x
    DOT:     '', // U+F444 nf-oct-dot_fill
    NEUTRAL: '', // U+F11A nf-fa-meh_o
    SYNC:    '󱥸', // U+F1978 nf-md-cog_sync (agent working spinner)
  },
  GIT: {
    BRANCH:       '', // U+F418 nf-oct-git_branch
    MERGE:        '', // U+F419 nf-oct-git_merge
    PULL_REQUEST: '', // U+F407 nf-oct-git_pull_request
    STASH:        '', // U+F187 nf-fa-archive
  },
  NAV: {
    CHEVRON_UP:    '', // U+F077 nf-fa-chevron_up
    CHEVRON_DOWN:  '', // U+F078 nf-fa-chevron_down
    CHEVRON_LEFT:  '', // U+F053 nf-fa-chevron_left
    CHEVRON_RIGHT: '', // U+F054 nf-fa-chevron_right
    SIDEBAR:       '', // U+EBF5 nf-cod-layout_sidebar_left
  },
  EDITOR: {
    FOLDER:   '', // U+F07B nf-fa-folder
    SEARCH:   '', // U+F002 nf-fa-search
    SYMBOL:   '', // U+EA8B nf-cod-symbol_namespace
    TERMINAL: '', // U+F120 nf-fa-terminal
    SERVER:   '', // U+F233 nf-fa-server
  },
  ACTION: {
    CLOSE: '', // U+F00D nf-fa-times
    EDIT:  '', // U+F040 nf-fa-pencil
    TRASH: '', // U+F1F8 nf-fa-trash
  },
  DIFF: {
    UNIFIED:      '', // U+F039 nf-fa-align_justify
    SIDE_BY_SIDE: '', // U+F0DB nf-fa-columns
  },
  SOCIAL: {
    GITHUB: '', // U+F09B nf-fa-github
    USER:   '', // U+F007 nf-fa-user
  },
} as const;
