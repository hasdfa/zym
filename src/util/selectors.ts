/*
 * selectors.ts — Atom-style CSS selector matching for command/keymap rules.
 *
 * Ported from xedel's utils/selectors.js. A selector like
 * `TextEditor:not(.mini) Box` is parsed into a list of `Rule`s; `matchesRule`
 * then walks a focused widget's ancestor chain to decide whether a rule applies.
 *
 * Adaptations for zym:
 *   - both an `#id` selector and a bare tag are matched against the widget's GTK
 *     name (`getName()`); `:not()`/class fragments match its CSS classes
 *     (`getCssClasses()`). A widget's name defaults to its node-gtk type name
 *     (e.g. "GtkText", "GtkSourceView"), but zym components override it with
 *     their JS class name (`widget.setName('Panel')` — e.g. the editor view is
 *     a `GtkSourceView` renamed to `TextEditor`). The convention is to target a
 *     zym component with `#id` (`#Panel`, `#TextEditor.insert-mode`) and a raw
 *     GTK widget by its type tag (e.g. `GtkText`);
 *   - the debug `console.log` at module load was removed and `translateTag`
 *     reduced to an identity passthrough (the Atom `atom-*` tag aliases don't
 *     map onto GTK widget names) — it stays as the extension point for aliases.
 */
import { createRequire } from 'node:module';
import type { Gtk } from '../gi.ts';
import { assert, unreachable } from './assert.ts';

// postcss-selector-parser is CommonJS; load it through createRequire so this
// stays an ES module without needing esModuleInterop (same trick as gi.ts).
const parser = createRequire(import.meta.url)('postcss-selector-parser') as
  typeof import('postcss-selector-parser');

type Widget = InstanceType<typeof Gtk.Widget>;

export interface RuleNode {
  element?: string;
  id?: string;
  has: string[];
  not: string[];
  combinator?: string;
}

export interface Rule {
  element: string | undefined;
  /** The subject's `#id` (matched, like a tag, against the widget's name). */
  id?: string;
  /**
   * The single bucket this rule is indexed under: its subject's tag or `#id` if
   * it has one, else its subject's first CSS class, else `*` (the wildcard
   * bucket). See `elementMatchKeys` for the lookup side.
   */
  key: string;
  description: RuleNode[];
  /**
   * CSS-style specificity of the whole selector, encoded as one comparable
   * number so a more specific rule outranks a less specific one. Used as the
   * tiebreaker when two matching bindings share the same priority — the more
   * specific selector wins (e.g. `#Panel .foo` beats `.foo`). See
   * `computeSpecificity`.
   */
  specificity: number;
  important?: boolean;
  platform?: string;
}

const PLATFORM_PATTERN = /\.platform-(\w+)/;

export function parseSelector(input: string): Rule[] {
  const results: Rule[] = [];

  const rules = input.split(',').map(r => r.trim());

  rules.forEach(ruleInput => {
    const important = ruleInput.endsWith('!important');
    const ruleCleanedInput = important ? ruleInput.replace('!important', '') : ruleInput;

    parser((selectors: any) => {
      const root = selectors;
      root.nodes.forEach((selector: any) => {
        const rule = parseRule(selector);
        rule.important = important;

        const platformIndex = rule.description.findIndex(r => PLATFORM_PATTERN.test(descriptionToString(r)));
        if (platformIndex !== -1) {
          assert(platformIndex + 1 < rule.description.length);
          assert(rule.description[platformIndex + 1].combinator !== undefined);

          const platformString = descriptionToString(rule.description[platformIndex]);
          const m = platformString.match(PLATFORM_PATTERN)!;
          rule.platform = m[1];
          rule.description.splice(platformIndex, 2);
        }

        results.push(rule);
      });
    }).processSync(ruleCleanedInput);
  });

  return results;
}

function parseRule(selector: any): Rule {
  const elements: RuleNode[] = [];
  let current: RuleNode = { element: undefined, has: [], not: [] };
  selector.nodes.forEach((node: any) => {
    switch (node.type) {
      case 'tag': {
        current.element = translateTag(node.value);
        break;
      }
      case 'id': {
        current.id = node.value;
        break;
      }
      case 'pseudo': {
        if (node.value === ':not')
          current.not.push(getValue(node.nodes[0].nodes[0]));
        else
          console.warn('Unhandled pseudo node value: ' + node.value);
        break;
      }
      case 'attribute':
      case 'class': {
        current.has.push(getValue(node));
        break;
      }
      case 'combinator': {
        elements.push(current);
        elements.push({ combinator: node.value, has: [], not: [] });
        current = { element: undefined, has: [], not: [] };
        break;
      }
      default: {
        console.warn('Unhandled selector node type: ' + node.type);
        break;
      }
    }
  });
  elements.push(current);

  // The subject is the rightmost compound (what the focused widget must match).
  // A rule is indexed by its subject's tag, or — for class-only selectors like
  // `.Panel` — its first class; `*` is the catch-all for selectors with neither.
  const subject = elements[elements.length - 1];
  const element = subject.element;
  const key = subject.element ?? subject.id ?? subject.has[0] ?? '*';

  if (key === '*')
    console.warn('Rule with no element, id, or class: ' + selector.toString());

  return {
    element,
    id: subject.id,
    key,
    description: elements,
    specificity: computeSpecificity(elements),
  };
}

// CSS specificity of a selector's compound chain, encoded as one comparable
// integer `a·1_000_000 + b·1_000 + c` (the classic `(ids, classes, tags)`
// triple). `#id` counts as an id, each class / `:not(.x)` argument as a class,
// each tag as a type — matching CSS, where `:not()` adds nothing itself but its
// argument's specificity counts. Combinators contribute nothing. The base of
// 1_000 leaves ample room for any realistic count without one column carrying
// into the next.
function computeSpecificity(description: RuleNode[]): number {
  let ids = 0, classes = 0, tags = 0;
  for (const node of description) {
    if (node.combinator) continue;
    if (node.id) ids += 1;
    if (node.element) tags += 1;
    classes += node.has.length + node.not.length;
  }
  return ids * 1_000_000 + classes * 1_000 + tags;
}

/**
 * The index keys an element can match a rule under: its GTK name (`getName()` —
 * the component's JS class name when set, else the node-gtk type name), each of
 * its CSS classes, and the `*` wildcard bucket. A rule lives in exactly one
 * bucket (its `key`); at lookup, a manager probes all of an element's keys, then
 * confirms with `matchesRule`.
 */
export function elementMatchKeys(element: Widget): string[] {
  return [element.getName() ?? '', ...element.getCssClasses(), '*'];
}

export function matchesRule(element: Widget, rule: Rule): boolean {
  if (rule.element && rule.element !== element.getName())
    return false;
  if (rule.id && rule.id !== element.getName())
    return false;

  let current: Widget | null = element;
  let combinator: string | undefined = undefined;
  let distance = 0;

  let i = rule.description.length - 1;
  let node: RuleNode | undefined = rule.description[i--];

  while (current && node) {

    if (node.combinator) {
      combinator = node.combinator;
      distance = 0;
      node = rule.description[i--];
    }

    if (node && matchesNode(current, node)) {
      node = rule.description[i--];
      if (combinator === '>' && distance > 1)
        return false;
      combinator = undefined;
    }
    else {
      if (current === element)
        return false;
    }

    current = current.getParent();
    distance += 1;
  }

  if (node)
    return false;

  return true;
}

function matchesNode(element: Widget, node: RuleNode): boolean {
  if (node.element && element.getName() !== node.element)
    return false;
  if (node.id && element.getName() !== node.id)
    return false;
  if (node.has.length === 0 && node.not.length === 0)
    return true;
  const classNames = element.getCssClasses();
  if (!node.has.every(c => classNames.includes(c)))
    return false;
  if (!node.not.every(c => !classNames.includes(c)))
    return false;
  return true;
}

function descriptionToString(d: RuleNode): string {
  if (d.combinator)
    return d.combinator;
  return [
    d.element,
    d.id ? `#${d.id}` : '',
    ...d.has.map(c => `.${c}`),
    ...d.not.map(c => `:not(.${c})`),
  ].join('');
}

function getValue(node: any): string {
  switch (node.type) {
    case 'class': return node.value;
    case 'attribute': return node.attribute ?? node._attribute;
    default:
      return unreachable();
  }
}

export function translateTag(tag: string): string {
  // Extension point for selector tag aliases. zym selectors use node-gtk
  // widget class names directly, so this is currently an identity mapping.
  return tag;
}
