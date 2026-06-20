/*
 * breadcrumb — walk the tree-sitter tree up from a position to the structural scopes
 * enclosing it (outermost → innermost), e.g. `class Foo` → `method bar`. Pure and
 * GTK-free so it's unit-testable against a real parse; the per-view SyntaxController
 * converts view→model coords and the LocationBar widget renders the result.
 */
import { isStructuralNodeType, isClassNodeType } from './nodeTypes.ts';

/** One enclosing scope: its display `name` (the symbol), the raw tree-sitter `type`, and the
 *  highlight `capture` name its identifier would get — so the UI can paint each crumb the same
 *  color the syntax highlighter paints that token. */
export interface Crumb {
  name: string;
  type: string;
  capture: string;
}

/** The highlight capture name a structural node's identifier resolves to, so the breadcrumb
 *  can reuse the syntax token color (via `resolveSyntaxColor`, longest-prefix fallback). */
function captureForType(type: string): string {
  if (/constructor/.test(type)) return 'constructor';
  if (isClassNodeType(type)) return 'type';
  if (/namespace|module/.test(type)) return 'namespace';
  return 'function'; // functions, methods, lambdas, arrows
}

// Don't render an unbounded chain — deeply nested closures would make a useless bar.
const MAX_DEPTH = 12;

/** Display name for a structural node, or null when it has none. Tree-sitter exposes the
 *  identifier via the `name` field on most declarations; a few shapes need fallbacks (Rust
 *  `impl` uses `type`; a function/closure bound to a name lives under a node whose own
 *  `name`/`key`/`declarator` field carries the binding). Returns null for a truly anonymous
 *  node (an inline callback/closure/lambda in any language) so the caller skips it — we never
 *  fall back to a humanized node type ("arrow function"), which is noise, not location. */
function nodeName(node: any): string | null {
  const field = (n: any, name: string): any => (n && n.childForFieldName ? n.childForFieldName(name) : null);
  const own = field(node, 'name') || field(node, 'type');
  if (own && own.text) return own.text;

  // A function/closure bound to a name: climb to the binding node (const decl, object
  // key, struct field, …) and use that. Grammar-agnostic — covers JS arrows/expressions,
  // Rust closures assigned to a `let`, Python lambdas assigned to a name, etc.
  const parent = node.parent;
  const binding = field(parent, 'name') || field(parent, 'key') || field(parent, 'declarator');
  if (binding && binding.text) return binding.text;

  return null; // anonymous — skip
}

/** The structural scopes enclosing `(row, column)`, outermost first. Empty at top level
 *  or with no tree. Anonymous functions/closures are omitted (no derivable name). */
export function breadcrumbAt(root: any, row: number, column: number): Crumb[] {
  let node: any = root.descendantForPosition({ row, column });
  const crumbs: Crumb[] = [];
  while (node && crumbs.length < MAX_DEPTH) {
    if (isStructuralNodeType(node.type)) {
      const name = nodeName(node);
      if (name) crumbs.push({ name, type: node.type, capture: captureForType(node.type) });
    }
    node = node.parent;
  }
  crumbs.reverse();
  return crumbs;
}
