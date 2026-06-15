/*
 * LSP completion source — adapts `textDocument/completion` to the autocompletion
 * framework. It asks the `LspManager` (primary server for the file) for raw LSP
 * items and maps them to the framework's `CompletionItem` shape (label, insert
 * text, kind tag, detail, documentation for the doc pane).
 *
 * Like the buffer-words source it's a factory over accessors, so it stays
 * decoupled from the widget and is unit-testable: it takes the manager (narrowed
 * to the two methods it uses) and a `getDocument` accessor (null for a fileless
 * buffer → no candidates). The `CompletionController` does prefix ranking; this
 * source supplies candidates, trigger characters, and preserves the server's
 * ordering via `sortText`.
 */
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver-protocol';
import type { CompletionItem as LspCompletionItem, MarkupContent, Range as LspRange } from 'vscode-languageserver-protocol';
import type { LspManager, LspDocument } from '../../lsp/LspManager.ts';
import { positionToPoint } from '../../lsp/position.ts';
import type { PositionEncoding } from '../../lsp/position.ts';
import { Range } from '../../text/Range.ts';
import type { CompletionContext, CompletionItem, CompletionSource } from './CompletionSource.ts';

// LSP numeric item kinds → the framework's short kind tags (drive the icon).
const KIND_NAMES: Record<number, string> = {
  [CompletionItemKind.Text]: 'text',
  [CompletionItemKind.Method]: 'method',
  [CompletionItemKind.Function]: 'function',
  [CompletionItemKind.Constructor]: 'constructor',
  [CompletionItemKind.Field]: 'field',
  [CompletionItemKind.Variable]: 'variable',
  [CompletionItemKind.Class]: 'class',
  [CompletionItemKind.Interface]: 'interface',
  [CompletionItemKind.Module]: 'module',
  [CompletionItemKind.Property]: 'property',
  [CompletionItemKind.Unit]: 'unit',
  [CompletionItemKind.Value]: 'value',
  [CompletionItemKind.Enum]: 'enum',
  [CompletionItemKind.Keyword]: 'keyword',
  [CompletionItemKind.Snippet]: 'snippet',
  [CompletionItemKind.Color]: 'color',
  [CompletionItemKind.File]: 'file',
  [CompletionItemKind.Reference]: 'reference',
  [CompletionItemKind.Folder]: 'folder',
  [CompletionItemKind.EnumMember]: 'enum-member',
  [CompletionItemKind.Constant]: 'constant',
  [CompletionItemKind.Struct]: 'struct',
  [CompletionItemKind.Event]: 'event',
  [CompletionItemKind.Operator]: 'operator',
  [CompletionItemKind.TypeParameter]: 'type-parameter',
};

function docText(doc: string | MarkupContent | undefined): string | undefined {
  if (doc === undefined) return undefined;
  return typeof doc === 'string' ? doc : doc.value;
}

/** Map one raw LSP item to the framework's shape. */
export function toCompletionItem(lsp: LspCompletionItem): CompletionItem {
  // We advertise no snippet support, so insert text is plain. Defensively, if a
  // server still sends a snippet, fall back to the label rather than inserting
  // `${1:…}` placeholders. `textEdit.newText` is the server's preferred insert.
  const isSnippet = lsp.insertTextFormat === InsertTextFormat.Snippet;
  const editText = lsp.textEdit && 'newText' in lsp.textEdit ? lsp.textEdit.newText : undefined;
  const insertText = isSnippet ? lsp.label : lsp.insertText ?? editText ?? lsp.label;
  // Prefer `labelDetails` (concise signature + source module) when the server
  // sends it — it keeps the import path out of `detail`. Falls back to `detail`.
  return {
    label: lsp.label,
    insertText,
    filterText: lsp.filterText ?? lsp.label,
    kind: lsp.kind ? KIND_NAMES[lsp.kind] : undefined,
    detail: lsp.labelDetails?.detail ?? lsp.detail,
    description: lsp.labelDetails?.description,
    documentation: docText(lsp.documentation),
    sortText: lsp.sortText ?? lsp.label,
  };
}

type LspCompletionApi = Pick<
  LspManager,
  'completion' | 'completionTriggerCharacters' | 'resolveCompletion' | 'completionPositionEncoding'
>;

/** The buffer range an item's `textEdit` replaces, in buffer codepoint coords.
 *  Prefers a plain `TextEdit.range`; for `InsertReplaceEdit`, the `insert` range
 *  (insert semantics — don't overwrite text after the cursor). */
function editReplaceRange(
  lsp: LspCompletionItem,
  doc: LspDocument,
  encoding: PositionEncoding,
): Range | undefined {
  const edit = lsp.textEdit;
  if (!edit) return undefined;
  const range: LspRange | undefined = 'range' in edit ? edit.range : edit.insert;
  if (!range) return undefined;
  return new Range(
    positionToPoint(range.start, doc.lineTextForRow(range.start.line), encoding),
    positionToPoint(range.end, doc.lineTextForRow(range.end.line), encoding),
  );
}

export function createLspCompletionSource(
  lsp: LspCompletionApi,
  getDocument: () => LspDocument | null,
): CompletionSource {
  return {
    name: 'lsp',
    // Language-aware results outrank the buffer-words fallback (default 0).
    priority: 100,
    // Dynamic: the server (and thus its trigger chars) isn't known until it's up.
    get triggerCharacters(): readonly string[] {
      const doc = getDocument();
      return doc ? lsp.completionTriggerCharacters(doc) : [];
    },
    async complete(context: CompletionContext): Promise<CompletionItem[]> {
      const doc = getDocument();
      if (!doc) return [];
      const encoding = lsp.completionPositionEncoding(doc);
      const items = await lsp.completion(doc, { triggerCharacter: context.triggerCharacter });
      return items.map((raw) => {
        const item = toCompletionItem(raw);
        // Honor the server's textEdit range, so a trigger-char completion (e.g.
        // after `.`, whose insertText re-includes the dot) replaces exactly what
        // the server intends instead of duplicating the trigger.
        if (encoding) item.replaceRange = editReplaceRange(raw, doc, encoding);
        // Most servers (tsserver, …) send documentation only on resolve. Attach a
        // lazy resolver the controller calls when the item is selected.
        if (item.documentation === undefined) {
          item.resolve = () => lsp.resolveCompletion(doc, raw).then(toCompletionItem);
        }
        return item;
      });
    },
  };
}
