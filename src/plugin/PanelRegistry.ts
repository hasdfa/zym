/*
 * PanelRegistry — collects panel contributions from plugins and notifies
 * AppWindow when new ones are registered (for dynamic late-loading).
 */
import { Emitter, Disposable } from '../util/eventKit.ts';
import type { PanelRegistration } from './types.ts';

class PanelRegistry {
  private readonly registrations: PanelRegistration[] = [];
  private readonly emitter = new Emitter();

  /** Contribute a panel. Returns a Disposable that removes it. */
  register(reg: PanelRegistration): Disposable {
    this.registrations.push(reg);
    this.emitter.emit('registered', reg);
    return new Disposable(() => {
      const i = this.registrations.indexOf(reg);
      if (i !== -1) this.registrations.splice(i, 1);
      this.emitter.emit('unregistered', reg);
    });
  }

  /** All currently registered panels. */
  list(): PanelRegistration[] {
    return [...this.registrations];
  }

  /** Fires when a panel is added (after plugins are already activated, for late loaders). */
  onRegistered(cb: (reg: PanelRegistration) => void): Disposable {
    return this.emitter.on('registered', cb as (value?: unknown) => void);
  }

  /** Fires when a panel is removed (plugin deactivated). */
  onUnregistered(cb: (reg: PanelRegistration) => void): Disposable {
    return this.emitter.on('unregistered', cb as (value?: unknown) => void);
  }
}

export const panelRegistry = new PanelRegistry();
