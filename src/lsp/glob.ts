/*
 * LSP file-watcher glob matching. Servers register watchers with glob patterns
 * (`**​/*.ts`, `**​/tsconfig.json`, …) via `client/registerCapability`; we match
 * changed paths against them before notifying `workspace/didChangeWatchedFiles`.
 *
 * Supports the common glob subset: `**` (any path segments), `*` (within a
 * segment), `?` (one non-separator char), and `{a,b}` alternation. Paths are
 * compared with forward slashes.
 */
const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIALS, '\\$&');
}

/** Convert a glob to an (unanchored) regex source matching a forward-slash path. */
function globBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?'; // `**/` → zero or more path segments
        } else {
          out += '.*'; // `**` → anything, across separators
        }
      } else {
        out += '[^/]*'; // `*` → within one segment
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        out += `(?:${glob.slice(i + 1, end).split(',').map(escapeLiteral).join('|')})`;
        i = end;
      }
    } else {
      out += escapeLiteral(c);
    }
  }
  return out;
}

/** Compile an LSP glob to an anchored RegExp matching a (relative) path. */
export function lspGlobToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob.replace(/\\/g, '/'))}$`);
}

/**
 * A RegExp matching absolute paths for a watcher registered with `pattern`
 * relative to `base` (the workspace or a RelativePattern base). `base` is treated
 * literally; `pattern` is a glob.
 */
export function watcherRegExp(base: string, pattern: string): RegExp {
  const baseNorm = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return new RegExp(`^${escapeLiteral(baseNorm)}/${globBody(pattern.replace(/\\/g, '/'))}$`);
}
