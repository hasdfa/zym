/*
 * The Markdown plugin — quilx's second plugin, and the proof that adding a
 * language is a small, isolated drop-in. Where the TypeScript plugin exercises
 * the grammar/LSP surface, this one adds detection, an LSP server (marksman),
 * and a config-schema contribution (`markdown.*`) — the `registerConfig` surface
 * TypeScript didn't touch.
 *
 * No tree-sitter grammar is contributed: the bundled `tree-sitter-wasms` pack
 * ships no Markdown grammar, so Markdown files get LSP features (diagnostics,
 * completion, go-to via marksman) without tree-sitter highlighting for now. The
 * day a Markdown wasm is vendored, a `registerGrammar` here lights highlighting
 * up with no other change.
 */
import type { Plugin, PluginContext } from '../../plugin/types.ts';
import type { ServerDef } from '../../lang/types.ts';
import type { ConfigSchema } from '../../util/Config.ts';

// marksman (https://github.com/artempyanykh/marksman) — the de-facto Markdown
// language server: wiki-links, completion, references, document symbols. A
// standalone binary (not an npm package, like deno), so no `install` spec — if
// it isn't on PATH the server is simply skipped, never crash-looped. It works
// per-file, so `singleFile` lets it activate even outside a project; a
// `.marksman.toml` or repo root is preferred when present.
const MARKSMAN: ServerDef = {
  name: 'marksman',
  command: 'marksman',
  args: ['server'],
  roots: ['.marksman.toml', '.git'],
  singleFile: true,
};

// Declared Markdown authoring preferences. They surface in the settings UI (which
// enumerates the config schema) and give a future Markdown formatter / editing
// command a place to read from; mirror the names markdownlint/prettier use.
const CONFIG: Record<string, ConfigSchema> = {
  'markdown.preferredHeadingStyle': {
    type: 'string',
    default: 'atx',
    enum: ['atx', 'setext'],
    description: 'Heading style to prefer: `atx` (`# Heading`) or `setext` (underlined).',
  },
  'markdown.preferredBulletMarker': {
    type: 'string',
    default: '-',
    enum: ['-', '*', '+'],
    description: 'Unordered-list bullet marker to prefer.',
  },
  'markdown.preferredEmphasisMarker': {
    type: 'string',
    default: '*',
    enum: ['*', '_'],
    description: 'Emphasis (italic) marker to prefer.',
  },
};

export const markdownPlugin: Plugin = {
  id: 'markdown',
  name: 'Markdown',
  description: 'Markdown: file detection, the marksman language server, and authoring preferences.',

  activate(ctx: PluginContext) {
    ctx.languages.registerLanguage({
      id: 'markdown',
      fileTypes: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'ronn', 'workbook'],
      // `markdown` is already a valid LSP languageId, so no `lspId` override.
    });
    ctx.languages.registerServer('markdown', MARKSMAN);
    ctx.registerConfig(CONFIG);
  },
};
