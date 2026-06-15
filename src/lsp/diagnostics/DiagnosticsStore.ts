/*
 * DiagnosticsStore — the source of truth for diagnostics, keyed by file path.
 *
 * Holds the raw LSP `Diagnostic[]` per file plus the server's position encoding,
 * so the UI layer can convert ranges to quilx `Point`/`Range` lazily against the
 * editor's line text (which the store doesn't have). Emits `did-update` with the
 * affected path whenever a file's diagnostics change, including clears.
 */
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { Emitter, Disposable } from '../../util/eventKit.ts';
import type { PositionEncoding } from '../position.ts';

export interface FileDiagnostics {
  diagnostics: Diagnostic[];
  /** Encoding of the server that produced them (for range conversion). */
  encoding: PositionEncoding;
}

export class DiagnosticsStore {
  private readonly byPath = new Map<string, FileDiagnostics>();
  private readonly emitter = new Emitter();

  /** Replace the diagnostics for a path; clears the entry when empty. */
  set(path: string, diagnostics: Diagnostic[], encoding: PositionEncoding): void {
    if (diagnostics.length === 0) this.byPath.delete(path);
    else this.byPath.set(path, { diagnostics, encoding });
    this.emitter.emit('did-update', path);
  }

  /** Drop a path's diagnostics (e.g. on close). No-op if absent. */
  clear(path: string): void {
    if (this.byPath.delete(path)) this.emitter.emit('did-update', path);
  }

  get(path: string): FileDiagnostics | undefined {
    return this.byPath.get(path);
  }

  /** Every path that currently has diagnostics. */
  paths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Total diagnostic count across all files. */
  get count(): number {
    let n = 0;
    for (const entry of this.byPath.values()) n += entry.diagnostics.length;
    return n;
  }

  onDidUpdate(handler: (path: string) => void): Disposable {
    return this.emitter.on('did-update', handler as (v?: unknown) => void);
  }
}
