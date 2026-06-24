/*
 * One-shot agent — run a single `claude -p` prompt to completion and return the
 * assistant's final text. Distinct from the persistent streaming SdkSession
 * (transport.ts): no turn loop, no rendering, no session continuity — just
 * prompt-in / text-out. Used for short auxiliary generations, e.g. auto-naming a
 * session (autoName.ts).
 *
 * The default implementation is hardcoded to `claude -p --model sonnet`, behind a
 * minimal `OneShotAgent` interface + a factory, so the backend (model, argv, even a
 * different provider) can become config-driven later without touching call sites.
 * A genuinely one-shot command, so it spawns via the shared process runner — not
 * the long-lived streaming transport (see docs/process-runner.md).
 */
import { runProcess } from '../process/runner.ts';

export interface OneShotOptions {
  /** Working directory — runs claude in the project so it uses the user's config/auth. */
  cwd?: string;
}

export interface OneShotAgent {
  /** Run `prompt` once; resolves the assistant's final text, rejects on failure. */
  run(prompt: string, options?: OneShotOptions): Promise<string>;
}

export interface ClaudeOneShotConfig {
  /** Base argv; default `['claude']`. */
  command?: string[];
  /** `--model` value; default `'sonnet'`. */
  model?: string;
}

/** Parse a `claude -p --output-format json` envelope into `{ ok, text }`. The wire
 *  shape is a single `{ type:'result', subtype, is_error, result }` object, where
 *  `result` is the assistant's final text. Pure (no IO) → unit-testable. */
export function parseOneShotEnvelope(raw: string): { ok: boolean; text: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, text: '' };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { ok: false, text: '' };
  }
  if (obj && typeof obj === 'object') {
    const o = obj as { result?: unknown; is_error?: unknown };
    if (typeof o.result === 'string') return { ok: o.is_error !== true, text: o.result };
  }
  return { ok: false, text: '' };
}

/** A one-shot agent backed by `claude -p --model <model> --output-format json`.
 *  Hardcoded defaults today; `config` is the seam for making model/argv
 *  user-configurable later. */
export function createOneShotAgent(config: ClaudeOneShotConfig = {}): OneShotAgent {
  const [file, ...base] = config.command ?? ['claude'];
  const model = config.model ?? 'sonnet';
  return {
    run(prompt, options = {}) {
      const args = [...base, '-p', '--model', model, '--output-format', 'json'];
      return new Promise<string>((resolve, reject) => {
        // The prompt rides stdin (closed after), so claude can't block on a tty read
        // (the runner gives every command a pipe on stdin — see docs/process-runner.md).
        runProcess({ file, args, cwd: options.cwd, input: prompt }, (res) => {
          if (!res.ok) {
            reject(new Error(`one-shot ${file} exited ${res.code}: ${res.stderr.toString().trim()}`));
            return;
          }
          const { ok, text } = parseOneShotEnvelope(res.stdout.toString());
          if (!ok) {
            reject(new Error('one-shot returned no result'));
            return;
          }
          resolve(text);
        });
      });
    },
  };
}
