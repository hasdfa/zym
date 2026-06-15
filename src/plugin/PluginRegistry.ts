/*
 * PluginRegistry — owns the set of known plugins and their activation state.
 *
 * A plugin is `register`ed (with its base directory, for asset resolution) and
 * later `activate`d: the registry builds a `PluginContextImpl`, runs the plugin's
 * `activate(ctx)`, and remembers the context. `deactivate` runs the plugin's own
 * teardown then disposes every contribution the context tracked. Activation is
 * idempotent and never throws — a plugin that fails to activate is logged and
 * left inactive, so one bad plugin can't block startup (same philosophy as the
 * keymap/config loaders).
 */
import { PluginContextImpl } from './PluginContext.ts';
import type { Plugin, PluginManifest } from './types.ts';

interface PluginEntry {
  plugin: Plugin;
  /** The plugin's base directory (asset resolution root). */
  dir: string;
  /** The live context while active; null when inactive. */
  context: PluginContextImpl | null;
}

/** A plugin's manifest plus whether it is currently active (for a manager UI). */
export interface PluginInfo extends PluginManifest {
  active: boolean;
}

export class PluginRegistry {
  private readonly entries = new Map<string, PluginEntry>();

  /** Register a plugin (inactive). `dir` is its directory for `ctx.resolve`. */
  register(plugin: Plugin, dir: string): void {
    if (this.entries.has(plugin.id)) {
      throw new Error(`plugin "${plugin.id}" is already registered`);
    }
    this.entries.set(plugin.id, { plugin, dir, context: null });
  }

  /** Manifest + active state for every registered plugin (registration order). */
  list(): PluginInfo[] {
    return [...this.entries.values()].map(({ plugin, context }) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      active: context !== null,
    }));
  }

  isActive(id: string): boolean {
    return this.entries.get(id)?.context != null;
  }

  /** Activate one plugin (no-op if unknown or already active). */
  async activate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.context) return;
    const context = new PluginContextImpl(entry.plugin.id, entry.dir);
    try {
      await entry.plugin.activate(context);
      entry.context = context;
    } catch (error) {
      // Roll back anything that registered before the failure.
      context.dispose();
      console.warn(`[plugin] "${id}" failed to activate: ${(error as Error).message}`);
    }
  }

  /** Deactivate one plugin (no-op if unknown or inactive). */
  async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.context) return;
    try {
      await entry.plugin.deactivate?.();
    } catch (error) {
      console.warn(`[plugin] "${id}" deactivate hook threw: ${(error as Error).message}`);
    }
    entry.context.dispose();
    entry.context = null;
  }

  /** Activate every registered plugin (startup). */
  async activateAll(): Promise<void> {
    for (const id of this.entries.keys()) await this.activate(id);
  }

  /** Deactivate every active plugin (shutdown). */
  async deactivateAll(): Promise<void> {
    for (const id of this.entries.keys()) await this.deactivate(id);
  }
}
