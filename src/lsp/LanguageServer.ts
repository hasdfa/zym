/*
 * LanguageServer — the LSP lifecycle and document state for one server process,
 * keyed by (server, rootDir) and shared by every open file under that root.
 *
 * Owns an `LspClient` (transport) and adds: the initialize→initialized→shutdown
 * handshake, negotiated capabilities + position encoding, open-document version
 * tracking, full-text document sync, and the typed requests Phase 1 uses
 * (go-to-definition). It speaks LSP types (URIs, `Position`); callers convert
 * to/from quilx `Point`/`Range` via `position.ts`.
 */
import {
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  DefinitionRequest,
  DeclarationRequest,
  TypeDefinitionRequest,
  ImplementationRequest,
  ReferencesRequest,
  HoverRequest,
  CompletionRequest,
  CompletionResolveRequest,
  TextDocumentSyncKind,
  type ClientCapabilities,
  type ServerCapabilities,
  type Diagnostic,
  type Position,
  type Location,
  type Definition,
  type LocationLink,
  type Hover,
  type CompletionList,
  type CompletionItem,
  type CompletionContext,
} from 'vscode-languageserver-protocol';
import { Emitter, Disposable } from '../util/eventKit.ts';
import { LspClient } from './LspClient.ts';
import { pathToUri } from './position.ts';
import type { ServerDef } from '../lang/types.ts';
import type { PositionEncoding } from './position.ts';

/** A diagnostics push for one document. */
export interface DiagnosticsEvent {
  uri: string;
  diagnostics: Diagnostic[];
}

export class LanguageServer {
  readonly langId: string;
  readonly rootDir: string;
  readonly key: string;
  private readonly client: LspClient;
  private readonly emitter = new Emitter();
  private capabilities: ServerCapabilities = {};
  private encoding: PositionEncoding = 'utf-16';
  private readyPromise: Promise<void> | null = null;
  // Server-specific init options (sent in `initialize`), e.g. tsserver plugins.
  private readonly initializationOptions: unknown;
  // uri → document version (monotonic, per LSP didChange contract).
  private readonly versions = new Map<string, number>();

  constructor(spec: ServerDef, langId: string, rootDir: string) {
    this.langId = langId;
    this.rootDir = rootDir;
    this.key = serverKey(spec.name, rootDir);
    this.initializationOptions = spec.initializationOptions;
    this.client = new LspClient(spec, rootDir);
  }

  get positionEncoding(): PositionEncoding {
    return this.encoding;
  }

  /** Start the process and run the initialize handshake (idempotent). */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doStart();
    return this.readyPromise;
  }

  private async doStart(): Promise<void> {
    this.client.start();
    this.client.onExit((code) => this.emitter.emit('exit', code));
    this.client.onNotification(PublishDiagnosticsNotification.type, (p) =>
      this.emitter.emit('diagnostics', { uri: p.uri, diagnostics: p.diagnostics } satisfies DiagnosticsEvent),
    );

    const result = await this.client.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToUri(this.rootDir),
      workspaceFolders: [{ uri: pathToUri(this.rootDir), name: this.rootDir }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.initializationOptions,
    });
    this.capabilities = result.capabilities;
    this.encoding = (result.capabilities.positionEncoding as PositionEncoding) ?? 'utf-16';
    this.client.sendNotification(InitializedNotification.type, {});
  }

  /** Whether the server advertised support for a navigation kind. */
  supportsNavigation(kind: NavigationKind): boolean {
    return !!this.capabilities[NAVIGATION[kind].capability];
  }

  /** Whether the server advertised support for find-references. */
  get hasReferences(): boolean {
    return !!this.capabilities.referencesProvider;
  }

  /** Whether the server advertised support for hover. */
  get hasHover(): boolean {
    return !!this.capabilities.hoverProvider;
  }

  /** Whether the server advertised support for completion. */
  get hasCompletion(): boolean {
    return !!this.capabilities.completionProvider;
  }

  /** Characters that should trigger completion (e.g. `.`), per the server. */
  get completionTriggerCharacters(): string[] {
    const provider = this.capabilities.completionProvider;
    return (typeof provider === 'object' && provider.triggerCharacters) || [];
  }

  /** Whether the server resolves completion items lazily (`completionItem/resolve`,
   *  where many servers — e.g. tsserver — send the documentation/detail). */
  get hasCompletionResolve(): boolean {
    const provider = this.capabilities.completionProvider;
    return typeof provider === 'object' && !!provider.resolveProvider;
  }

  // --- document sync (full-text) --------------------------------------------

  // Defer a document notification until the initialize handshake has completed,
  // so notifications never reach the server before `initialized` (LSP ordering).
  // `start()` is idempotent; chaining on the same promise preserves call order.
  private send(fn: () => void): void {
    void this.start().then(fn).catch(() => {
      // Server failed to initialize / went away — drop the notification.
    });
  }

  didOpen(path: string, languageId: string, text: string): void {
    const uri = pathToUri(path);
    this.versions.set(uri, 1);
    this.send(() =>
      this.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text },
      }),
    );
  }

  /** Full-text sync: send the entire buffer as a single change. */
  didChange(path: string, text: string): void {
    const uri = pathToUri(path);
    if (!this.versions.has(uri)) return; // not open
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.send(() =>
      this.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      }),
    );
  }

  didSave(path: string, text?: string): void {
    const uri = pathToUri(path);
    if (!this.versions.has(uri)) return;
    this.send(() =>
      this.client.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: { uri },
        ...(text !== undefined ? { text } : {}),
      }),
    );
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    if (!this.versions.delete(uri)) return;
    this.send(() =>
      this.client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      }),
    );
  }

  isOpen(path: string): boolean {
    return this.versions.has(pathToUri(path));
  }

  // --- requests --------------------------------------------------------------

  /** Resolve a navigation (definition/declaration/type-def/impl); LSP locations or null. */
  async navigate(
    kind: NavigationKind,
    path: string,
    position: Position,
  ): Promise<Definition | LocationLink[] | null> {
    if (!this.supportsNavigation(kind)) return null;
    await this.start();
    return this.client.sendRequest(NAVIGATION[kind].request.type, {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  /** Find all references to the symbol at `position` (declaration included). */
  async references(path: string, position: Position): Promise<Location[] | null> {
    if (!this.hasReferences) return null;
    await this.start();
    return this.client.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
      context: { includeDeclaration: true },
    });
  }

  /** Hover (type/docs) for the symbol at `position`, or null. */
  async hover(path: string, position: Position): Promise<Hover | null> {
    if (!this.hasHover) return null;
    await this.start();
    return this.client.sendRequest(HoverRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
    });
  }

  /** Completion candidates at `position` (a list or bare array), or null. */
  async completion(
    path: string,
    position: Position,
    context?: CompletionContext,
  ): Promise<CompletionList | CompletionItem[] | null> {
    if (!this.hasCompletion) return null;
    await this.start();
    return this.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: pathToUri(path) },
      position,
      context,
    });
  }

  /** Resolve a completion item (fills in documentation/detail the list omitted). */
  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    if (!this.hasCompletionResolve) return item;
    await this.start();
    return this.client.sendRequest(CompletionResolveRequest.type, item);
  }

  // --- events ----------------------------------------------------------------

  onDiagnostics(handler: (event: DiagnosticsEvent) => void): Disposable {
    return this.emitter.on('diagnostics', handler as (v?: unknown) => void);
  }

  onExit(handler: (code: number | null) => void): Disposable {
    return this.emitter.on('exit', handler as (v?: unknown) => void);
  }

  /** Politely shut the server down, then tear down the transport. */
  async shutdown(): Promise<void> {
    try {
      await this.client.sendRequest(ShutdownRequest.type, undefined);
      this.client.sendNotification(ExitNotification.type, undefined);
    } catch {
      // ignore — we kill the process next regardless
    }
    this.client.dispose();
  }
}

/** Stable identity for reusing a server across files of one project. */
export function serverKey(serverName: string, rootDir: string): string {
  return `${serverName} ${rootDir}`;
}

/** Single-target navigation requests (each returns one or more locations). */
export type NavigationKind = 'definition' | 'declaration' | 'typeDefinition' | 'implementation';

// Maps a navigation kind to its request type and the capability that gates it.
const NAVIGATION = {
  definition: { request: DefinitionRequest, capability: 'definitionProvider' },
  declaration: { request: DeclarationRequest, capability: 'declarationProvider' },
  typeDefinition: { request: TypeDefinitionRequest, capability: 'typeDefinitionProvider' },
  implementation: { request: ImplementationRequest, capability: 'implementationProvider' },
} satisfies Record<NavigationKind, { request: { type: unknown }; capability: keyof ServerCapabilities }>;

// Advertised client capabilities (full-text sync, diagnostics, navigation,
// references); extended as features land.
const CLIENT_CAPABILITIES: ClientCapabilities = {
  general: { positionEncodings: ['utf-8', 'utf-16'] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true },
    publishDiagnostics: { relatedInformation: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    declaration: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    completion: {
      dynamicRegistration: false,
      // No snippet support yet, so servers send plain insert text (not ${…} tabstops).
      // `labelDetailsSupport` makes servers split the concise signature
      // (`labelDetails.detail`) from the source module (`labelDetails.description`)
      // instead of cramming both into `detail`.
      completionItem: {
        snippetSupport: false,
        documentationFormat: ['markdown', 'plaintext'],
        labelDetailsSupport: true,
      },
    },
  },
  workspace: { workspaceFolders: true },
};

export { TextDocumentSyncKind };
