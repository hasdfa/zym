/*
 * Theme — a single definition holding both UI chrome colors and syntax
 * (tree-sitter capture) colors. Themes live as JSON next to this module (e.g.
 * kyntell.json) and are loaded through `loadTheme`; the active theme is exported
 * as `theme`. Keeping UI and syntax in one definition means a palette can be
 * swapped wholesale without the two drifting apart.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';

/** UI / editor chrome colors. */
export interface UiColors {
  /** Default editor text foreground. */
  fg: string;
}

/*
 * Syntax colors: capture name → foreground color, keyed by the capture names
 * Zed's queries emit (see syntax/grammar.ts). Values mirror kyntell.vim's
 * tree-sitter `@capture` → group mapping, resolved to each group's `guifg`.
 *
 * Dotted captures resolve by longest-prefix fallback in the highlighter
 * (syntax-controller's resolveTag): e.g. @keyword.control/.import/.declaration
 * reuse `keyword`; @type.builtin/.class/.name reuse `type`; @function.method
 * reuses `function`. Only list a dotted key to give it a *distinct* color.
 * Captures with no entry (@variable, @embedded, @text.jsx, …) stay the default
 * foreground.
 *
 * KEY ORDER MATTERS: one GtkTextTag is created per entry in JSON order, and tag
 * priority follows creation order (later = higher). A node can match several
 * patterns at once, and all matching tags apply — priority decides the winner.
 * So more-specific / should-win categories come LAST: escapes after `string`;
 * `tag` before `type` so components render as types; `property` before
 * `function` so method names win.
 */
export type SyntaxColors = Record<string, string>;

export interface Theme {
  name: string;
  ui: UiColors;
  syntax: SyntaxColors;
}

/** Load the theme definition named `<name>.json` from this directory. */
export function loadTheme(name: string): Theme {
  const file = Path.join(import.meta.dirname, `${name}.json`);
  return JSON.parse(Fs.readFileSync(file, 'utf8')) as Theme;
}

/** The active theme. */
export const theme = loadTheme('kyntell');
