/*
 * Frecency — a small persisted "frequency × recency" store that lets pickers
 * float the things you actually use to the top. Each pick is recorded under a
 * namespace ("file", "command", …) keyed by a stable id (an absolute path, a
 * command name); the store ranks a key by how often and how recently it was
 * chosen, the same idea behind editor quick-open ordering.
 *
 * Storage mirrors the session store: one JSON file under the XDG state dir
 * (`$XDG_STATE_HOME/quilx/frecency.json`, falling back to `~/.local/state`),
 * written atomically. Reads are forgiving — a missing or corrupt file just
 * starts from empty, so a bad file never blocks a picker.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';

interface Entry {
  /** Number of times this key has been chosen. */
  count: number;
  /** Epoch milliseconds of the most recent choice. */
  lastAccess: number;
}

type Store = Record<string, Record<string, Entry>>; // namespace → key → entry

const HOUR = 3.6e6;
// Bounds and shape of the additive bonus a picker adds to a fuzzy score. Kept
// small so a clearly better text match still wins, but enough to break ties and
// surface familiar items. The bonus grows with the log of the raw frecency, so
// the gap between "used once" and "used twice" matters more than "50 vs 51".
const BONUS_SCALE = 0.45;
const BONUS_MAX = 1.5;

/** Recency multiplier for an age, in the spirit of Firefox's frecency buckets. */
function recencyMultiplier(ageMs: number): number {
  const hours = ageMs / HOUR;
  if (hours < 1) return 4;
  if (hours < 24) return 2;
  if (hours < 24 * 7) return 1;
  if (hours < 24 * 30) return 0.5;
  return 0.25;
}

export class FrecencyStore {
  private readonly path: string;
  private store: Store | null = null; // lazily loaded on first use

  /**
   * @param stateDir override for the XDG state base (tests pass a temp dir);
   *   defaults to `$XDG_STATE_HOME` or `~/.local/state`.
   */
  constructor(stateDir?: string) {
    const base = stateDir ?? process.env.XDG_STATE_HOME ?? Path.join(Os.homedir(), '.local', 'state');
    this.path = Path.join(base, 'quilx', 'frecency.json');
  }

  /** Record that `key` was chosen in `namespace`, just now. Persists immediately. */
  record(namespace: string, key: string): void {
    const store = this.load();
    const ns = (store[namespace] ??= {});
    const entry = (ns[key] ??= { count: 0, lastAccess: 0 });
    entry.count += 1;
    entry.lastAccess = Date.now();
    this.save();
  }

  /** Raw frecency of `key`: choice count weighted by how recent it is (0 if unseen). */
  score(namespace: string, key: string): number {
    const entry = this.load()[namespace]?.[key];
    if (!entry) return 0;
    return entry.count * recencyMultiplier(Date.now() - entry.lastAccess);
  }

  /**
   * A bounded, additive ranking bonus for `key`, ready to add onto a picker's
   * fuzzy score (and to order the no-query list). Zero for unseen keys.
   */
  boost(namespace: string, key: string): number {
    const score = this.score(namespace, key);
    if (score <= 0) return 0;
    return Math.min(BONUS_MAX, BONUS_SCALE * Math.log2(1 + score));
  }

  private load(): Store {
    if (this.store) return this.store;
    try {
      const parsed = JSON.parse(Fs.readFileSync(this.path, 'utf8'));
      this.store = parsed && typeof parsed === 'object' ? (parsed as Store) : {};
    } catch {
      this.store = {}; // missing or corrupt — start fresh
    }
    return this.store;
  }

  private save(): void {
    try {
      Fs.mkdirSync(Path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      Fs.writeFileSync(tmp, JSON.stringify(this.store ?? {}, null, 2) + '\n');
      Fs.renameSync(tmp, this.path);
    } catch {
      // A failed write just means this pick isn't remembered; never fatal.
    }
  }
}

/** The shared app-wide frecency store. */
export const frecency = new FrecencyStore();
