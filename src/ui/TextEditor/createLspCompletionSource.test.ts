import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver-protocol';
import type { CompletionItem as LspCompletionItem } from 'vscode-languageserver-protocol';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import { createLspCompletionSource, toCompletionItem } from './createLspCompletionSource.ts';
import type { CompletionContext } from './CompletionSource.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';

function ctx(triggerCharacter?: string): CompletionContext {
  const cursor = new Point(0, 0);
  return {
    prefix: '',
    cursor,
    replaceRange: new Range(cursor, cursor),
    line: '',
    trigger: triggerCharacter ? 'character' : 'auto',
    triggerCharacter,
  };
}

const doc = {} as LspDocument;

describe('toCompletionItem', () => {
  it('maps the useful LSP fields, defaulting insert/filter/sort to the label', () => {
    const item = toCompletionItem({
      label: 'map',
      kind: CompletionItemKind.Method,
      detail: '(method) Array.map',
      documentation: 'Calls a function on each element.',
    });
    assert.equal(item.label, 'map');
    assert.equal(item.insertText, 'map');
    assert.equal(item.filterText, 'map');
    assert.equal(item.sortText, 'map');
    assert.equal(item.kind, 'method');
    assert.equal(item.detail, '(method) Array.map');
    assert.equal(item.documentation, 'Calls a function on each element.');
  });

  it('prefers labelDetails (detail + description) over the flat detail', () => {
    const item = toCompletionItem({
      label: 'createServer',
      detail: 'vscode-languageserver-protocol', // the junky flat detail
      labelDetails: { detail: '(options)', description: 'node:http' },
    });
    assert.equal(item.detail, '(options)');
    assert.equal(item.description, 'node:http');
  });

  it('extracts MarkupContent documentation', () => {
    const item = toCompletionItem({
      label: 'x',
      documentation: { kind: 'markdown', value: '# Doc' },
    });
    assert.equal(item.documentation, '# Doc');
  });

  it('prefers insertText, then textEdit.newText, over the label', () => {
    assert.equal(toCompletionItem({ label: 'a', insertText: 'aaa' }).insertText, 'aaa');
    assert.equal(
      toCompletionItem({
        label: 'b',
        textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'bbb' },
      }).insertText,
      'bbb',
    );
  });

  it('falls back to the label for snippet items (no snippet support)', () => {
    const item = toCompletionItem({
      label: 'forEach',
      insertText: 'forEach((${1:item}) => $0)',
      insertTextFormat: InsertTextFormat.Snippet,
    });
    assert.equal(item.insertText, 'forEach');
  });

  it('passes through filterText and sortText when given', () => {
    const item = toCompletionItem({ label: 'Foo', filterText: 'foo', sortText: '0001' });
    assert.equal(item.filterText, 'foo');
    assert.equal(item.sortText, '0001');
  });
});

describe('createLspCompletionSource', () => {
  it('maps the manager results and forwards the trigger character', async () => {
    let seenTrigger: string | undefined = 'unset';
    const lsp = {
      completion: async (_doc: LspDocument, opts: { triggerCharacter?: string }): Promise<LspCompletionItem[]> => {
        seenTrigger = opts.triggerCharacter;
        return [{ label: 'length', kind: CompletionItemKind.Property }];
      },
      completionTriggerCharacters: () => ['.'],
      resolveCompletion: async (_d: LspDocument, item: LspCompletionItem) => item,
      completionPositionEncoding: () => null,
    };
    const source = createLspCompletionSource(lsp, () => doc);
    const items = await source.complete(ctx('.'));
    assert.deepEqual(items.map((i) => i.label), ['length']);
    assert.equal(items[0].kind, 'property');
    assert.equal(seenTrigger, '.');
  });

  it('exposes the server trigger characters, and none without a document', () => {
    const lsp = {
      completion: async (): Promise<LspCompletionItem[]> => [],
      completionTriggerCharacters: () => ['.', ':'],
      resolveCompletion: async (_d: LspDocument, item: LspCompletionItem) => item,
      completionPositionEncoding: () => null,
    };
    assert.deepEqual([...(createLspCompletionSource(lsp, () => doc).triggerCharacters ?? [])], ['.', ':']);
    assert.deepEqual([...(createLspCompletionSource(lsp, () => null).triggerCharacters ?? [])], []);
  });

  it('yields nothing for a fileless buffer (no document)', async () => {
    const lsp = {
      completion: async (): Promise<LspCompletionItem[]> => [{ label: 'x' }],
      completionTriggerCharacters: () => [],
      resolveCompletion: async (_d: LspDocument, item: LspCompletionItem) => item,
      completionPositionEncoding: () => null,
    };
    assert.deepEqual(await createLspCompletionSource(lsp, () => null).complete(ctx()), []);
  });

  it('attaches a lazy resolver only for items missing documentation', async () => {
    const lsp = {
      completion: async (): Promise<LspCompletionItem[]> => [
        { label: 'noDoc' },
        { label: 'hasDoc', documentation: 'already here' },
      ],
      completionTriggerCharacters: () => [],
      resolveCompletion: async (_d: LspDocument, item: LspCompletionItem): Promise<LspCompletionItem> => ({
        ...item,
        documentation: 'resolved docs',
      }),
      completionPositionEncoding: () => null,
    };
    const items = await createLspCompletionSource(lsp, () => doc).complete(ctx());
    const [noDoc, hasDoc] = items;
    assert.equal(hasDoc.resolve, undefined); // documentation already present
    assert.ok(noDoc.resolve, 'missing-doc item gets a resolver');
    assert.equal((await noDoc.resolve!()).documentation, 'resolved docs');
  });

  it("maps a textEdit range to the item's buffer replaceRange", async () => {
    // tsserver-style member completion after `Path.`: newText re-includes the
    // dot, with a textEdit range covering it ([0,4]–[0,5]).
    const docWithLine = {
      getPath: () => '/x.ts',
      lineTextForRow: () => 'Path.',
    } as unknown as LspDocument;
    const lsp = {
      completion: async (): Promise<LspCompletionItem[]> => [
        {
          label: 'basename',
          textEdit: {
            range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
            newText: '.basename',
          },
        },
      ],
      completionTriggerCharacters: () => ['.'],
      resolveCompletion: async (_d: LspDocument, item: LspCompletionItem) => item,
      completionPositionEncoding: () => 'utf-16' as const,
    };
    const [item] = await createLspCompletionSource(lsp, () => docWithLine).complete(ctx('.'));
    assert.equal(item.insertText, '.basename');
    assert.deepEqual(
      { sr: item.replaceRange!.start.row, sc: item.replaceRange!.start.column,
        er: item.replaceRange!.end.row, ec: item.replaceRange!.end.column },
      { sr: 0, sc: 4, er: 0, ec: 5 },
    );
  });
});
