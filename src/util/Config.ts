/*
 * Config.ts — a schema-driven settings store, modelled on Atom's `atom.config`.
 *
 * Unlike a bare key→value map, every parameter is declared up front with a
 * `type`, a `default`, and optional constraints (`enum`, `minimum`, `maximum`).
 * That schema drives three things ad-hoc stores can't offer:
 *
 *   - Defaults live with the declaration, so `get` never needs a fallback and
 *     `unset` can restore a value precisely.
 *   - `set` coerces (e.g. the string "3" → the integer 3) and validates against
 *     the schema, clamping numbers and rejecting values that don't fit.
 *   - Reads/writes are observable: `observe` fires immediately and on change,
 *     `onDidChange` fires with `{ newValue, oldValue }`, both returning
 *     Disposables — the same shape Atom-ported code expects.
 *
 * The engine is namespace-agnostic; callers instantiate it with their own
 * schema (see `ui/TextEditor/vim/settings.ts` for the vim layer's instance).
 */
import { Emitter, type Disposable } from './eventKit.ts';

export type ConfigType = 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';

export type ConfigValue =
  | boolean
  | number
  | string
  | readonly unknown[]
  | Record<string, unknown>
  | null;

export interface ConfigSchema {
  type: ConfigType;
  default: ConfigValue;
  /** Permitted values; a `set` outside this list is rejected. */
  enum?: ConfigValue[];
  /** Inclusive bounds for numeric types; out-of-range values are clamped. */
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface ConfigChange {
  newValue: ConfigValue;
  oldValue: ConfigValue;
}

/** Returned by coercion when a value can't be made to fit its schema. */
const INVALID = Symbol('invalid');

function clone(value: ConfigValue): ConfigValue {
  if (Array.isArray(value)) return value.slice();
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
}

function equals(a: ConfigValue, b: ConfigValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equals(v as ConfigValue, b[i] as ConfigValue));
  }
  return false;
}

export class Config {
  private readonly schema: Record<string, ConfigSchema>;
  private readonly store = new Map<string, ConfigValue>();
  private readonly emitter = new Emitter();

  constructor(schema: Record<string, ConfigSchema> = {}) {
    this.schema = schema;
  }

  /** The schema entry for `keyPath`, or `null` if the key is undeclared. */
  getSchema(keyPath: string): ConfigSchema | null {
    return this.schema[keyPath] ?? null;
  }

  /**
   * Declare (or replace) the schema for `keyPath` at runtime — the hook
   * subsystems use to contribute their own parameters to the global config,
   * mirroring Atom's `config.setSchema`. Returns this for chaining.
   */
  setSchema(keyPath: string, entry: ConfigSchema): this {
    this.schema[keyPath] = entry;
    return this;
  }

  /** Merge a whole `{ keyPath: schema }` map in one call. */
  addSchema(schema: Record<string, ConfigSchema>): this {
    for (const keyPath of Object.keys(schema)) this.schema[keyPath] = schema[keyPath];
    return this;
  }

  /** All declared `[keyPath, schema]` pairs, in declaration order — the hook a
   *  settings UI uses to enumerate every parameter it can edit. */
  schemaEntries(): Array<[string, ConfigSchema]> {
    return Object.entries(this.schema);
  }

  /**
   * A view of this config confined to a `namespace.` prefix. Subsystems get a
   * `settings`-style object (`get('foo')` ⇄ `get('namespace.foo')` on the
   * parent) without owning a separate store — the global config stays the
   * single source of truth, the way vim-mode-plus reads its keys off `atom.config`.
   */
  scope(namespace: string): ScopedConfig {
    return new ScopedConfig(this, namespace);
  }

  /** The declared default, independent of any value `set` since. */
  getDefault(keyPath: string): ConfigValue | undefined {
    const entry = this.schema[keyPath];
    return entry ? clone(entry.default) : undefined;
  }

  /** True once an explicit value has been `set` (and not `unset`). */
  has(keyPath: string): boolean {
    return this.store.has(keyPath);
  }

  /** The current value: an explicit one if set, otherwise the schema default. */
  get(keyPath: string): ConfigValue | undefined {
    if (this.store.has(keyPath)) return this.store.get(keyPath)!;
    return this.getDefault(keyPath);
  }

  /**
   * Coerce and validate `value` against the schema, store it, and notify
   * observers. Returns `false` (without changing anything) when the value can't
   * be made to fit a declared schema; undeclared keys are stored as-is.
   */
  set(keyPath: string, value: ConfigValue): boolean {
    const entry = this.schema[keyPath];
    const next = entry ? this.coerce(value, entry) : value;
    if (next === INVALID) return false;

    const oldValue = this.get(keyPath) ?? null;
    this.store.set(keyPath, next as ConfigValue);
    if (!equals(oldValue, next as ConfigValue)) {
      this.emitter.emit(keyPath, { newValue: next, oldValue });
    }
    return true;
  }

  /** Drop any explicit value, reverting `keyPath` to its schema default. */
  unset(keyPath: string): void {
    if (!this.store.has(keyPath)) return;
    const oldValue = this.get(keyPath) ?? null;
    this.store.delete(keyPath);
    const newValue = this.get(keyPath) ?? null;
    if (!equals(oldValue, newValue)) {
      this.emitter.emit(keyPath, { newValue, oldValue });
    }
  }

  /** Flip a boolean parameter; returns the same success flag as `set`. */
  toggle(keyPath: string): boolean {
    return this.set(keyPath, !this.get(keyPath));
  }

  /** Invoke `callback` with the current value now, then on every change. */
  observe(keyPath: string, callback: (value: ConfigValue | undefined) => void): Disposable {
    callback(this.get(keyPath));
    return this.emitter.on(keyPath, (change) => callback((change as ConfigChange).newValue));
  }

  /** Invoke `callback` with `{ newValue, oldValue }` on each change. */
  onDidChange(keyPath: string, callback: (change: ConfigChange) => void): Disposable {
    return this.emitter.on(keyPath, callback as (value?: unknown) => void);
  }

  private coerce(value: ConfigValue, entry: ConfigSchema): ConfigValue | typeof INVALID {
    let next: ConfigValue = value;

    switch (entry.type) {
      case 'boolean':
        next = typeof value === 'string' ? value === 'true' : Boolean(value);
        break;
      case 'integer': {
        const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
        if (!Number.isFinite(n)) return INVALID;
        next = Math.round(n);
        break;
      }
      case 'number': {
        const n = typeof value === 'string' ? parseFloat(value) : Number(value);
        if (!Number.isFinite(n)) return INVALID;
        next = n;
        break;
      }
      case 'string':
        if (typeof value !== 'string') return INVALID;
        break;
      case 'array':
        if (!Array.isArray(value)) return INVALID;
        next = value.slice();
        break;
      case 'object':
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return INVALID;
        next = { ...value };
        break;
    }

    if (entry.enum && !entry.enum.some((allowed) => equals(allowed, next))) return INVALID;

    if (typeof next === 'number') {
      if (entry.minimum !== undefined) next = Math.max(entry.minimum, next);
      if (entry.maximum !== undefined) next = Math.min(entry.maximum, next);
    }

    return next;
  }
}

/**
 * A namespaced facade over a `Config`. Every key is transparently prefixed with
 * `namespace.`, so callers work with short keys while values live in the shared
 * parent store. Created via `config.scope(namespace)`.
 */
export class ScopedConfig {
  private readonly config: Config;
  private readonly namespace: string;

  constructor(config: Config, namespace: string) {
    this.config = config;
    this.namespace = namespace;
  }

  private key(keyPath: string): string {
    return `${this.namespace}.${keyPath}`;
  }

  /** Register this namespace's parameters; keys are prefixed automatically. */
  register(schema: Record<string, ConfigSchema>): this {
    for (const keyPath of Object.keys(schema)) {
      this.config.setSchema(this.key(keyPath), schema[keyPath]);
    }
    return this;
  }

  getSchema(keyPath: string): ConfigSchema | null {
    return this.config.getSchema(this.key(keyPath));
  }

  getDefault(keyPath: string): ConfigValue | undefined {
    return this.config.getDefault(this.key(keyPath));
  }

  has(keyPath: string): boolean {
    return this.config.has(this.key(keyPath));
  }

  get(keyPath: string): ConfigValue | undefined {
    return this.config.get(this.key(keyPath));
  }

  set(keyPath: string, value: ConfigValue): boolean {
    return this.config.set(this.key(keyPath), value);
  }

  unset(keyPath: string): void {
    this.config.unset(this.key(keyPath));
  }

  toggle(keyPath: string): boolean {
    return this.config.toggle(this.key(keyPath));
  }

  observe(keyPath: string, callback: (value: ConfigValue | undefined) => void): Disposable {
    return this.config.observe(this.key(keyPath), callback);
  }

  onDidChange(keyPath: string, callback: (change: ConfigChange) => void): Disposable {
    return this.config.onDidChange(this.key(keyPath), callback);
  }
}

export default Config;
