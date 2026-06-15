/*
 * LSP server registry — resolves "which server(s) launch for this file, and how"
 * from Helix's `languages.toml` (https://github.com/helix-editor/helix), the one
 * established, declarative source that maps file types → language → server
 * command/args/roots/config. We don't hand-maintain any of this.
 *
 * Data flow: a vendored snapshot (`./languages.toml`, committed so the first run
 * works offline) is the baseline; `refresh()` fetches the latest from GitHub into
 * a cache (`$XDG_CONFIG_HOME/quilx/lsp/languages.toml`) which then takes
 * precedence. Helix configs assume the server binary is already on `PATH` — fine
 * for a client-only editor (we never download servers).
 *
 * `normalize()` is the pure, testable core; `LspRegistry` wraps it with file IO,
 * caching, refresh, and user-config overrides.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { parse } from 'smol-toml';

const HELIX_LANGUAGES_URL =
  'https://raw.githubusercontent.com/helix-editor/helix/master/languages.toml';

/** A resolved language server launch spec. */
export interface ServerSpec {
  /** Server id (the key under `[language-server.*]` in languages.toml). */
  name: string;
  command: string;
  args: string[];
  /** Server-specific settings / init options (Helix `config`). */
  config?: unknown;
  /** Extra environment for the spawned process. */
  environment?: Record<string, string>;
}

/** A language matched to a file, with its root markers and servers (in order). */
export interface LanguageMatch {
  /** Helix language id (e.g. `typescript`, `rust`). */
  langId: string;
  /** Root-marker filenames used to locate the project root. */
  roots: string[];
  /** Server specs in Helix's declared order (first is preferred). */
  servers: ServerSpec[];
}

/** Per-language override, keyed by langId, from user config `lsp.servers`. */
export interface ServerOverride {
  command?: string;
  args?: string[];
  config?: unknown;
  environment?: Record<string, string>;
}

export interface RegistryOptions {
  /** langId → override merged over the resolved server(s). */
  serverOverrides?: Record<string, ServerOverride>;
  /** langIds for which no server should start. */
  disabledLanguages?: string[];
}

// --- raw shapes from the TOML ----------------------------------------------

interface RawServer {
  command?: string;
  args?: string[];
  config?: unknown;
  environment?: Record<string, string>;
}

type FileTypeEntry = string | { glob: string };
type ServerEntry = string | { name: string; config?: unknown };

interface RawLanguage {
  name: string;
  'file-types'?: FileTypeEntry[];
  roots?: string[];
  'language-servers'?: ServerEntry[];
}

interface NormalizedLanguage {
  langId: string;
  filenames: string[]; // exact basename matches
  extensions: string[]; // matched as `*.<ext>`
  globs: RegExp[]; // matched against basename
  roots: string[];
  servers: ServerSpec[];
}

/** Compile a Helix glob (basename pattern) to a RegExp. Supports `*` and `?`. */
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

function mergeConfig(base: unknown, override: unknown): unknown {
  if (
    base && typeof base === 'object' && !Array.isArray(base) &&
    override && typeof override === 'object' && !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = mergeConfig(out[k], v);
    }
    return out;
  }
  return override === undefined ? base : override;
}

/**
 * Parse and normalize a `languages.toml` into a lookup keyed by file. Pure — no
 * file IO — so it is unit-testable with a sample TOML string.
 */
export function normalize(tomlText: string, options: RegistryOptions = {}): NormalizedRegistry {
  const data = parse(tomlText) as {
    'language-server'?: Record<string, RawServer>;
    language?: RawLanguage[];
  };
  const rawServers = data['language-server'] ?? {};
  const disabled = new Set(options.disabledLanguages ?? []);
  const overrides = options.serverOverrides ?? {};

  const languages: NormalizedLanguage[] = [];
  for (const lang of data.language ?? []) {
    if (!lang.name || disabled.has(lang.name)) continue;
    const serverEntries = lang['language-servers'] ?? [];
    if (serverEntries.length === 0) continue;

    const override = overrides[lang.name];
    const servers: ServerSpec[] = [];
    for (const entry of serverEntries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const raw = rawServers[name];
      const command = override?.command ?? raw?.command;
      if (!command) continue; // server not launchable by command (skip silently)
      let config = raw?.config;
      if (typeof entry === 'object' && entry.config !== undefined) config = mergeConfig(config, entry.config);
      if (override?.config !== undefined) config = mergeConfig(config, override.config);
      servers.push({
        name,
        command,
        args: override?.args ?? raw?.args ?? [],
        config,
        environment: { ...raw?.environment, ...override?.environment },
      });
    }
    if (servers.length === 0) continue;

    const filenames: string[] = [];
    const extensions: string[] = [];
    const globs: RegExp[] = [];
    for (const ft of lang['file-types'] ?? []) {
      if (typeof ft === 'string') {
        // Helix matches a string file-type as an extension (`*.ft`) or an exact
        // basename. A dot-bearing string (e.g. `go.mod`) is an exact name.
        if (ft.includes('.')) filenames.push(ft);
        else {
          extensions.push(ft.toLowerCase());
          filenames.push(ft); // also matches an extensionless file named `ft`
        }
      } else if (ft && typeof ft === 'object' && ft.glob) {
        globs.push(globToRegExp(ft.glob));
      }
    }

    languages.push({
      langId: lang.name,
      filenames,
      extensions,
      globs,
      roots: lang.roots ?? [],
      servers,
    });
  }

  return new NormalizedRegistry(languages);
}

/** An immutable, queryable view over normalized language data. */
export class NormalizedRegistry {
  private readonly languages: NormalizedLanguage[];

  constructor(languages: NormalizedLanguage[]) {
    this.languages = languages;
  }

  get languageCount(): number {
    return this.languages.length;
  }

  /** Resolve the language + servers for a file path, or null if unsupported. */
  serverSpecsForPath(filePath: string): LanguageMatch | null {
    const base = Path.basename(filePath);
    const ext = Path.extname(base).slice(1).toLowerCase();
    for (const lang of this.languages) {
      const matches =
        lang.filenames.includes(base) ||
        (ext !== '' && lang.extensions.includes(ext)) ||
        lang.globs.some((re) => re.test(base));
      if (matches) {
        return { langId: lang.langId, roots: lang.roots, servers: lang.servers };
      }
    }
    return null;
  }
}

// --- file-backed registry ---------------------------------------------------

function cachePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  return Path.join(configHome, 'quilx', 'lsp', 'languages.toml');
}

function vendoredPath(): string {
  return Path.join(import.meta.dirname, 'languages.toml');
}

/**
 * File-backed registry: loads the cache (or vendored snapshot) lazily and
 * exposes the normalized lookup. `refresh()` updates the cache from upstream.
 */
export class LspRegistry {
  private normalized: NormalizedRegistry | null = null;
  private options: RegistryOptions;
  private readonly url: string;

  constructor(options: RegistryOptions = {}, url: string = HELIX_LANGUAGES_URL) {
    this.options = options;
    this.url = url;
  }

  /** Re-normalize with new options (e.g. after a config change). */
  setOptions(options: RegistryOptions): void {
    this.options = options;
    this.normalized = null;
  }

  private load(): NormalizedRegistry {
    if (this.normalized) return this.normalized;
    let text: string;
    try {
      text = Fs.readFileSync(cachePath(), 'utf8');
    } catch {
      text = Fs.readFileSync(vendoredPath(), 'utf8');
    }
    this.normalized = normalize(text, this.options);
    return this.normalized;
  }

  serverSpecsForPath(filePath: string): LanguageMatch | null {
    return this.load().serverSpecsForPath(filePath);
  }

  /**
   * Fetch the latest `languages.toml` into the cache and re-normalize. Resolves
   * to true on success, false on any failure (network, bad data) — failures are
   * non-fatal; the current data keeps serving.
   */
  async refresh(): Promise<boolean> {
    try {
      const res = await fetch(this.url);
      if (!res.ok) return false;
      const text = await res.text();
      // Validate before persisting so we never cache garbage.
      const next = normalize(text, this.options);
      const dest = cachePath();
      Fs.mkdirSync(Path.dirname(dest), { recursive: true });
      Fs.writeFileSync(dest, text);
      this.normalized = next;
      return true;
    } catch {
      return false;
    }
  }
}
