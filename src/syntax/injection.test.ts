/*
 * End-to-end test of language injection through the real SyntaxController: a
 * Markdown buffer whose fenced ```ts block must be painted with the *injected*
 * TypeScript grammar's tags (and inline `code` with the inline grammar's). This
 * exercises the whole path — plugin activation → grammar preload → detection →
 * collectCaptures (base + injected) → paintCaptures — against the vendored wasms.
 *
 * Headless: SyntaxController.setLanguageForPath runs one synchronous refresh, so
 * no main loop is needed. Skips if the Markdown grammar isn't vendored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gtk, GtkSource, Pango } from '../gi.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars } from './grammar.ts';
import { SyntaxController } from './syntax-controller.ts';

Gtk.init();

const HERE = Path.dirname(fileURLToPath(import.meta.url));
const hasMarkdownWasm = Fs.existsSync(
  Path.resolve(HERE, '../plugins/markdown/grammars/tree-sitter-markdown.wasm'));

function asIter(r: any): any {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

test('injection: a fenced ```ts block in Markdown is painted by the TypeScript grammar',
  { skip: !hasMarkdownWasm && 'Markdown grammar not vendored' },
  async () => {
    registerBuiltinPlugins();
    await plugins.activateAll(); // contributes the markdown + typescript grammars
    await preloadGrammars();

    const md = '# Title\n\nSome **bold** and `code`.\n\n```ts\nconst answer = 42\n```\n';
    const tmp = Path.join(Os.tmpdir(), `quilx-inj-${process.pid}.md`);
    Fs.writeFileSync(tmp, md);

    const buffer = new GtkSource.Buffer();
    buffer.setText(md, -1);
    const view = new GtkSource.View({ buffer });
    const syntax = new SyntaxController(view, buffer, { folding: false });

    // setLanguageForPath runs one synchronous refresh (parse + inject + paint).
    assert.equal(syntax.setLanguageForPath(tmp), true);

    const tagTable = (buffer as any).getTagTable();
    const keywordTag = tagTable.lookup('ts:keyword');
    assert.ok(keywordTag, 'the keyword tag should exist');

    // `const` inside the fence must carry the keyword tag — only the injected
    // TypeScript grammar produces it; the Markdown grammar never would.
    const at = md.indexOf('const') + 2; // mid-token, away from the boundary
    const iter = asIter((buffer as any).getIterAtOffset(at));
    assert.ok(iter.hasTag(keywordTag), 'injected TypeScript keyword tag should paint `const`');

    // Styled tags (not just color): `**bold**` (via the inline grammar injection)
    // must carry the shared bold decoration tag, which is genuinely bold weight.
    const boldTag = tagTable.lookup('ts*bold');
    assert.ok(boldTag, 'the bold decoration tag should exist');
    assert.equal(boldTag.weight, Pango.Weight.BOLD, 'the bold tag should be bold weight');
    const boldAt = md.indexOf('bold') + 1;
    const boldIter = asIter((buffer as any).getIterAtOffset(boldAt));
    assert.ok(boldIter.hasTag(boldTag), 'bold text should carry the bold decoration tag');

    // Fenced code gets a full-line (paragraph) background that layers *under* the
    // injected token colors: the `const` position carries both a paragraph-bg tag
    // and the keyword color, while a heading line outside the fence carries none.
    const hasParagraphBg = (it: any): boolean =>
      (it.getTags() as any[]).some((t) => t.paragraphBackgroundSet === true);
    assert.ok(hasParagraphBg(iter), 'fenced code should have a full-line background');
    const headingIter = asIter((buffer as any).getIterAtOffset(md.indexOf('Title')));
    assert.ok(!hasParagraphBg(headingIter), 'a non-code line should have no line background');

    Fs.unlinkSync(tmp);
  });
