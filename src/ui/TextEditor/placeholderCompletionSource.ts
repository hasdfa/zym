/*
 * placeholderCompletionSource — a trivial completion source: a fixed vocabulary
 * filtered by the typed prefix. Its only job is to exercise the widget + event
 * pipeline while the real sources (buffer words, LSP, Copilot) are built. Swap it
 * out / add the real ones via `CompletionController.addSource`.
 */
import type { CompletionContext, CompletionItem, CompletionSource } from './CompletionSource.ts';

const KEYWORDS = [
  'async', 'await', 'break', 'case', 'class', 'const', 'constructor', 'continue',
  'default', 'export', 'extends', 'function', 'implements', 'import', 'instanceof',
  'interface', 'private', 'protected', 'public', 'readonly', 'return', 'static',
  'switch', 'typeof', 'undefined', 'while', 'yield',
];

export const placeholderCompletionSource: CompletionSource = {
  name: 'placeholder',
  complete(context: CompletionContext): CompletionItem[] {
    return KEYWORDS.map((word): CompletionItem => ({ label: word, kind: 'keyword', detail: 'keyword' }));
  },
};
