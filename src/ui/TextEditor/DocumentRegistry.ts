/*
 * DocumentRegistry — the app-wide table of open `Document`s, ref-counted so a file's
 * shared buffer/LSP state lives exactly as long as some view is showing it.
 *
 * Phase 1 of the document-registry refactor (see
 * tasks/code-editing/document-registry.md). Today every file editor is still 1:1 with
 * its document (`AppWindow.openFile` reveals an already-open tab rather than opening a
 * second view), so the ref count is always 1 in practice. The registry exists so the
 * later phases — per-view cursor, then N views per document, then the live
 * see-definition peek — can hand multiple views the *same* `Document` and dispose it
 * only when the last one goes.
 *
 * Dedup is by the document's live `currentFile` (not the path passed to `acquire`), so
 * a "Save As" that retargets a document keeps a single entry — mirroring the old
 * `editors.find(e => e.currentFile === path)` reveal check, lifted to the document level.
 */
import { Document } from './Document.ts';

interface Entry {
  doc: Document;
  /** The path this entry was acquired for — the dedup key until the document has
   *  loaded (then its live `currentFile` takes over, so a "Save As" retargets cleanly). */
  requestedPath: string;
  /** Number of live views onto `doc`; the document is disposed when this hits 0. */
  refs: number;
}

// The file an entry currently represents: its loaded file once known, else the path
// it was acquired for (a freshly-created, not-yet-loaded document).
function entryPath(entry: Entry): string {
  return entry.doc.currentFile ?? entry.requestedPath;
}

export class DocumentRegistry {
  private readonly entries = new Set<Entry>();

  /**
   * Get-or-create the `Document` for `path`, incrementing its ref count. Returns
   * `isNew` so the caller knows whether it must load the file (a freshly-created
   * document is empty; an already-open one shares the live buffer). Pair every
   * `acquire` with exactly one `release`.
   */
  acquire(path: string): { document: Document; isNew: boolean } {
    for (const entry of this.entries) {
      if (entryPath(entry) === path) {
        entry.refs++;
        return { document: entry.doc, isNew: false };
      }
    }
    const entry: Entry = { doc: new Document(), requestedPath: path, refs: 1 };
    this.entries.add(entry);
    return { document: entry.doc, isNew: true };
  }

  /** Drop one reference to `document`; dispose + forget it once the last view goes. */
  release(document: Document): void {
    for (const entry of this.entries) {
      if (entry.doc !== document) continue;
      if (--entry.refs <= 0) {
        entry.doc.dispose();
        this.entries.delete(entry);
      }
      return;
    }
  }

  /** The Document currently representing `path`, if any. */
  find(path: string): Document | undefined {
    for (const entry of this.entries) if (entryPath(entry) === path) return entry.doc;
    return undefined;
  }

  /** All open documents (debug / introspection). */
  documents(): Document[] {
    return [...this.entries].map((entry) => entry.doc);
  }
}
