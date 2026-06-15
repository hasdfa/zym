/*
 * The language layer: the `LanguageRegistry` plus the shared `languages`
 * singleton with the built-in pack registered. Consumers (`grammar.ts`,
 * `LspManager`) import `languages`; plugins (later) register more on it.
 */
import { LanguageRegistry } from './LanguageRegistry.ts';
import { registerBuiltins } from './builtin.ts';

export { LanguageRegistry } from './LanguageRegistry.ts';
export type { ActiveServerOptions } from './LanguageRegistry.ts';
export type { LanguageDef, GrammarDef, ServerDef, ActiveServer } from './types.ts';

/** The application-wide registry, pre-populated with the built-in languages. */
export const languages = new LanguageRegistry();
registerBuiltins(languages);
