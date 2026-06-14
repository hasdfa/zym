/*
 * selectors.ts — Atom-style CSS selector matching for command/keymap rules.
 *
 * Ported from xedel's utils/selectors.js. A selector like
 * `TextEditor:not(.mini) Box` is parsed into a list of `Rule`s; `matchesRule`
 * then walks a focused widget's ancestor chain to decide whether a rule applies.
 *
 * Adaptations for quilx:
 *   - elements are matched against the node-gtk widget's `constructor.name`
 *     (e.g. "View", "Box") and its GTK CSS classes via `getCssClasses()`;
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
  has: string[];
  not: string[];
  combinator?: string;
}

export interface Rule {
  element: string | undefined;
  description: RuleNode[];
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

  const element = elements[elements.length - 1].element;

  if (!element)
    console.warn('Rule with no element: ' + selector.toString());

  return {
    element,
    description: elements,
  };
}

export function matchesRule(element: Widget, rule: Rule): boolean {
  if (rule.element && rule.element !== element.constructor.name)
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
  if (node.element && element.constructor.name !== node.element)
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
  return [d.element, ...d.has.map(c => `.${c}`), ...d.not.map(c => `:not(.${c})`)].join('');
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
  // Extension point for selector tag aliases. quilx selectors use node-gtk
  // widget class names directly, so this is currently an identity mapping.
  return tag;
}
