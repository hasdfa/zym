/*
 * The language layer: the `LanguageRegistry` plus the shared `languages`
 * singleton. The registry starts empty; plugins populate it at activation
 * (`src/plugins/*` via the `PluginContext`). Consumers (`grammar.ts`,
 * `LspManager`) import `languages` and read grammar/server contributions off it.
 *
 * Activation order matters: plugins must be activated (see `src/index.ts`,
 * `plugins.activateAll()`) before grammars are preloaded or files are opened, so
 * the registry is populated by the time anything reads it.
 */
export { LanguageRegistry } from './LanguageRegistry.ts';
export type { ActiveServerOptions } from './LanguageRegistry.ts';
export type { LanguageDef, GrammarDef, ServerDef, ActiveServer } from './types.ts';

import { LanguageRegistry } from './LanguageRegistry.ts';

/** The application-wide registry; populated by plugins at activation. */
export const languages = new LanguageRegistry();
