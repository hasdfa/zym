/*
 * KeymapManager — maps keystroke sequences to commands, scoped by selector.
 *
 * Ported from xedel's keymap-manager.js. A CAPTURE-phase key controller on the
 * application window receives every key press; keystrokes are normalized to
 * `Key`s and matched (supporting multi-key sequences like "ctrl-k ctrl-s")
 * against the keymaps registered for the focused widget and its ancestors. A
 * full match is dispatched through `quilx.commands`; a partial match queues the
 * keystrokes and swallows the event until the sequence completes or breaks.
 *
 * Adaptation for quilx: references the `quilx` global (window + commands)
 * instead of xedel's `xedel` global; otherwise behavior is preserved.
 */
import { Disposable } from './util/eventKit.ts';
import { Key } from './keymap/Key.ts';
import { unreachable } from './util/assert.ts';
import { parseSelector, matchesRule, elementMatchKeys, type Rule } from './util/selectors.ts';
import { getActiveElements } from './util/getActiveElements.ts';
import { Gtk } from './gi.ts';
import { quilx } from './quilx.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

const EVENT_CONTINUE         = false;
const EVENT_STOP_PROPAGATION = true;

// A binding value of `unset!` cancels keymap handling for its keystroke (the key
// falls through to the focused widget). Used to release a binding in contexts
// that need the raw key — e.g. `space` in a text entry, terminal, or insert mode.
const UNSET = 'unset!';

const MATCH = {
  PARTIAL: 'PARTIAL',
  FULL:    'FULL',
} as const;

/** A keymap value: a command name, a command name with arguments, or an inline
 *  function. The `{ command, args }` form is how a binding passes arguments. */
export type CommandRef = { command: string; args?: unknown[] };
type Effect = string | CommandRef | ((this: Widget, event: unknown, element: Widget) => void);
type Keymap = Record<string, Effect>;
type KeymapBySelector = Record<string, Keymap>;

type Listener = (key: Key, element: Widget | undefined, elements: Widget[]) => boolean;

interface KeymapEntry {
  rule: Rule;
  keymap: Keymap;
  priority: number;
}

interface KeybindingMatch {
  match: typeof MATCH.PARTIAL | typeof MATCH.FULL;
  keybinding: string;
  effect: Effect;
  element: Widget;
  priority: number;
}

export class KeymapManager {
  static MATCH = MATCH;

  listeners: Listener[] = [];

  queuedKeystrokes: Key[] = [];

  // When a queued prefix already has a complete binding but a longer sequence
  // could still match (e.g. `y` is Yank, but `y s` is Surround), we hold the
  // prefix's full match here and wait. If the next key extends the sequence we
  // use the longer match; if it breaks the chain we fall back to this. See
  // `processKeystroke`.
  deferredFullMatches: KeybindingMatch[] | null = null;

  keymapsByName: Record<string, KeymapEntry[]> = {};
  keymapsBySource: Record<string, KeymapBySelector> = {};

  controller?: InstanceType<typeof Gtk.EventControllerKey>;

  initialize(): void {
    this.controller = new Gtk.EventControllerKey();
    this.controller.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    this.controller.on('key-pressed', this.onWindowKeyPressEvent);
    quilx.window!.addController(this.controller);
  }

  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  // add: (source, keyBindingsBySelector, priority=0). Higher-priority bindings
  // win when multiple full matches resolve the same keystroke (e.g. a user
  // keymap layered over the defaults).
  add(source: string, keymapBySelector: KeymapBySelector, priority = 0): Disposable {
    Object.keys(keymapBySelector).forEach(selector => {

      const keymap = keymapBySelector[selector];
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;
        if (this.keymapsByName[key] === undefined)
          this.keymapsByName[key] = [];
        this.keymapsByName[key].push({ rule, keymap, priority });
      });
    });

    this.keymapsBySource[source] = keymapBySelector;

    return new Disposable(() => {
      this.removeBindingsFromSource(source);
    });
  }

  removeBindingsFromSource(source: string): void {
    const keymapBySelector = this.keymapsBySource[source];

    if (!keymapBySelector)
      return;

    Object.keys(keymapBySelector).forEach(selector => {
      const keymap = keymapBySelector[selector];
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;
        if (this.keymapsByName[key] === undefined)
          return;
        this.keymapsByName[key] =
          this.keymapsByName[key].filter(k => k.keymap !== keymap);
      });
    });

    delete this.keymapsBySource[source];
  }

  onWindowKeyPressEvent = (keyval: number, keycode: number, state: number): boolean => {
    const key = Key.fromArgs(keyval, keycode, state);

    const elements = getActiveElements();

    for (const listener of this.listeners) {
      if (listener(key, elements[0], elements) === EVENT_STOP_PROPAGATION)
        return EVENT_STOP_PROPAGATION;
    }

    if (key.isModifier())
      return EVENT_CONTINUE;

    return this.processKeystroke(key);
  };

  // Match `key` (appended to any queued prefix) against the focused widget chain
  // and act on the result. Re-entrant: when a sequence dead-ends after a
  // deferred full match, the deferred command is dispatched and `key` is
  // re-processed from a clean slate (which is why elements are re-read here —
  // dispatching may have changed the mode/scope).
  private processKeystroke(key: Key): boolean {
    const elements = getActiveElements();
    const keystrokes = this.queuedKeystrokes.concat(key);
    const matches = this.collectMatches(keystrokes, elements);

    // `unset!` directive: if an unset binding is among the highest-priority
    // matches for this keystroke, cancel handling and let the key reach the
    // focused widget (e.g. type a literal space in an entry / terminal / insert
    // mode). Checked across full AND partial matches, so an unset on the `space`
    // prefix also releases the `space …` leader sequences.
    if (matches.length > 0) {
      const maxPriority = Math.max(...matches.map(m => m.priority));
      if (matches.some(m => m.priority === maxPriority && m.effect === UNSET)) {
        this.queuedKeystrokes = [];
        this.deferredFullMatches = null;
        return EVENT_CONTINUE;
      }
    }
    // Drop unset markers so they are never treated as commands below.
    const active = matches.filter(m => m.effect !== UNSET);

    // Highest priority first; ties keep registration/chain order (stable sort).
    const fullMatches = active
      .filter(m => m.match === MATCH.FULL)
      .sort((a, b) => b.priority - a.priority);
    const partialMatches = active.filter(m => m.match === MATCH.PARTIAL);

    // A longer sequence may still complete — wait for the next key. Remember
    // this sequence's own complete binding (if any) as the fallback for when the
    // chain breaks, so e.g. `y` (Yank) survives even though `y s` (Surround) is
    // a longer candidate. A prefix that only extends (no full match of its own)
    // keeps the previously-remembered fallback.
    if (partialMatches.length > 0) {
      if (fullMatches.length > 0) this.deferredFullMatches = fullMatches;
      this.queuedKeystrokes = keystrokes;
      return EVENT_STOP_PROPAGATION;
    }

    // The sequence is complete — dispatch its full match.
    if (fullMatches.length > 0) {
      this.queuedKeystrokes = [];
      this.deferredFullMatches = null;
      return this.dispatchFullMatches(fullMatches, elements)
        ? EVENT_STOP_PROPAGATION
        : EVENT_CONTINUE;
    }

    // Dead-end: nothing matches the full sequence. If a shorter prefix had a
    // complete binding, run it now (e.g. `y` then a non-`s` key ⇒ Yank), then
    // re-process the current key from scratch so it can start a new sequence.
    const deferred = this.deferredFullMatches;
    this.deferredFullMatches = null;
    this.queuedKeystrokes = [];
    if (deferred) {
      this.dispatchFullMatches(deferred, elements);
      return this.processKeystroke(key);
    }
    return EVENT_CONTINUE;
  }

  // Collect every full/partial keybinding match for `keystrokes` across the
  // focused widget and its ancestors.
  private collectMatches(keystrokes: Key[], elements: Widget[]): KeybindingMatch[] {
    const matches: KeybindingMatch[] = [];

    for (const element of elements) {
      const keymaps = elementMatchKeys(element)
        .flatMap((key) => this.keymapsByName[key] || []);

      if (keymaps.length === 0)
        continue;

      const matchingKeymaps = keymaps.filter(k => matchesRule(element, k.rule));
      const matchingKeybindings =
        matchingKeymaps.map(k => matchKeybinding(keystrokes, k.keymap, element, k.priority)).flat();

      if (matchingKeybindings.length === 0)
        continue;

      matches.push(...matchingKeybindings);
    }

    return matches;
  }

  // Dispatch the first full match (highest priority) that resolves to a command,
  // returning whether one did. String / `{ command, args }` effects are command
  // names resolved along the focus chain so a binding matched on one widget can
  // invoke a command hosted on an ancestor (e.g. the file tree's `space w` →
  // `file:save` on the window); a function effect runs on the matched element.
  private dispatchFullMatches(fullMatches: KeybindingMatch[], elements: Widget[]): boolean {
    for (const fullMatch of fullMatches) {
      const { keybinding, effect, element } = fullMatch;

      let didDispatch: boolean;
      if (typeof effect === 'function') {
        didDispatch = quilx.commands.dispatch(element, effect);
      } else if (typeof effect === 'string') {
        didDispatch = quilx.commands.dispatchAlongChain(elements, effect);
      } else {
        didDispatch = quilx.commands.dispatchAlongChain(elements, effect.command, ...(effect.args ?? []));
      }
      if (!didDispatch)
        continue;

      const label = typeof effect === 'object' ? effect.command : effect;
      console.log(`${element.getName()}: [${keybinding}]: ${label}`);
      return true;
    }
    return false;
  }
}

function matchKeybinding(queuedKeystrokes: Key[], keymap: Keymap, element: Widget, priority: number): KeybindingMatch[] {
  const keybindingKeys = Object.keys(keymap);
  const results: KeybindingMatch[] = [];

  outer: for (const keybinding of keybindingKeys) {
    const keyStack = keybinding.split(/\s+/).map(d => Key.fromDescription(d));

    if (keyStack.length < queuedKeystrokes.length)
      continue;

    for (let i = 0; i < queuedKeystrokes.length; i++) {
      const key = queuedKeystrokes[i];

      if (!keyStack[i] || !key.equals(keyStack[i]!))
        continue outer;
    }

    if (queuedKeystrokes.length < keyStack.length) {
      results.push({
        match: MATCH.PARTIAL,
        keybinding,
        effect: keymap[keybinding],
        element,
        priority,
      });
    }
    else if (keyStack.length === queuedKeystrokes.length) {
      results.push({
        match: MATCH.FULL,
        keybinding,
        effect: keymap[keybinding],
        element,
        priority,
      });
    }
    else {
      unreachable();
    }
  }

  return results;
}
