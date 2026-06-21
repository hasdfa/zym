# IDE Integration (`claude --ide`)

Quilx implements the Claude Code IDE integration protocol so that agents
spawned inside quilx automatically get full IDE context — current
selection, open editors, diagnostics — and can call back into quilx to
open files, show diffs, etc.

## Protocol overview

Claude discovers IDEs via a **lock file** at `~/.claude/ide/<port>.lock`
and a pair of env vars set on the claude process. Communication uses
WebSocket with JSON-RPC 2.0 (a WebSocket variant of MCP, spec
2025-03-26).

**Lock file** (written by quilx on startup):
```json
{
  "pid": 12345,
  "workspaceFolders": ["/path/to/project"],
  "ideName": "Quilx",
  "transport": "ws",
  "authToken": "<32-char lowercase hex from OS CSPRNG>"
}
```

**Env vars** injected into every spawned claude process:
- `CLAUDE_CODE_SSE_PORT=<port>`
- `ENABLE_IDE_INTEGRATION=true`

**Auth**: Claude sends `x-claude-code-ide-authorization: <authToken>` as
a WebSocket upgrade header; reject connections that fail to match.

## Notifications (IDE → Claude)

Push these on editor state changes:

### `selection_changed`
```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "selected text",
    "filePath": "/absolute/path/to/file.ts",
    "fileUrl": "file:///absolute/path/to/file.ts",
    "selection": {
      "start": { "line": 10, "character": 5 },
      "end":   { "line": 15, "character": 20 },
      "isEmpty": false
    }
  }
}
```

### `at_mentioned`
Sent when the user explicitly sends selection context to an agent (the
"send to agent" action, `agent:send-selection`):
```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/path/to/file",
    "lineStart": 10,
    "lineEnd": 20
  }
}
```

## Tools (Claude → IDE)

The IDE registers these as MCP tools. All respond with
`{ content: [{ type: "text", text: "..." }] }`.

| Tool | What it does |
|------|-------------|
| `openFile` | Open a file; optional `startText`/`endText` to select a range; `preview` / `makeFrontmost` flags |
| `openDiff` | Show `old_file_path` vs `new_file_contents` in a diff view; **blocking** — returns `FILE_SAVED` or `DIFF_REJECTED` |
| `getCurrentSelection` | Return current selection in the active editor |
| `getLatestSelection` | Return most recent selection (even if editor lost focus) |
| `getOpenEditors` | List open tabs (uri, isActive, label, languageId, isDirty) |
| `getWorkspaceFolders` | List workspace roots |
| `getDiagnostics` | LSP diagnostics for a file URI (or all files) |
| `checkDocumentDirty` | Whether a file has unsaved changes |
| `saveDocument` | Save a file |
| `close_tab` | Close a tab by name |
| `closeAllDiffTabs` | Close all open diff tabs |
| `executeCode` | *(Jupyter only — not applicable to quilx)* |

## Design

- **WebSocket server** — a `ws` server on a random port (10000–65535)
  bound to `127.0.0.1`, started at startup and shut down on exit. The
  server is a singleton for the quilx process (not per-workbench); all
  connected claude sessions share it. One claude process = one
  connection.
- **Lock file lifecycle** — `~/.claude/ide/<port>.lock` is written on
  server start and removed on clean shutdown (the directory is ensured
  to exist). The auth token comes from
  `crypto.randomBytes(16).toString('hex')` (Node CSPRNG).
- **Auth handshake** — on WebSocket upgrade, read the
  `x-claude-code-ide-authorization` header and reject (403) if it
  doesn't match the lock-file token.
- **Env var injection** — when spawning a claude agent
  (`AgentTerminal`/`ClaudeSession`), inject `CLAUDE_CODE_SSE_PORT` and
  `ENABLE_IDE_INTEGRATION=true` into the child env. The port is the same
  for all agents (one server, one lock file, multiple connections).
- **Tool dispatch** — a JSON-RPC request router maps `tools/call` to
  handler functions and responds with a `tools/call` result or a
  JSON-RPC error. Tool calls that touch editor state operate on the
  **currently active workbench** at call time.

### Tool handlers

- **`selection_changed`** — connect to the active `TextEditor`'s
  selection-change signal and broadcast to all connected clients.
  Debounce to avoid flooding on rapid cursor moves (~50 ms).
- **`at_mentioned`** — the existing "send to agent" action
  (`agent:send-selection`) also emits this over the WebSocket.
- **`openFile`** — call the existing `workbench.openFile` path; honour
  `startText`/`endText` by scanning the buffer for the text and building
  a selection; `preview` maps to the preview-tab mode if we add it.
- **`openDiff`** — open a `DiffView` from the tool's `old_file_path` /
  `new_file_contents`; block (keep the JSON-RPC request open) until the
  user saves or closes, then respond `FILE_SAVED` / `DIFF_REJECTED`.
  This is the primary "propose a change" flow. Blocking means the
  response is deferred: hold the request id and resolve it when the diff
  tab is closed.
- **`getCurrentSelection` / `getLatestSelection`** — read from the
  active `TextEditor`; cache the last selection for `getLatest`.
- **`getOpenEditors`** — enumerate `workbench.center` tabs.
- **`getWorkspaceFolders`** — return the active workbench root(s).
- **`getDiagnostics`** — query `DiagnosticsManager` for the given URI or
  all files; map to the expected shape (`severity` as string, `range`,
  `source`).
- **`checkDocumentDirty` / `saveDocument`** — forward to the `Document`
  from the `DocumentRegistry`.
- **`close_tab`** — find a tab by name in `workbench.center` and close
  it.
- **`closeAllDiffTabs`** — close all tabs whose widget is a `DiffView`
  or `SideBySideDiffView`.
- **`executeCode`** — Jupyter-specific; register it as a stub that
  returns an error, or omit it from the tools list entirely.

## Open questions / future work

- Per-worktree workbenches may want the lock file to list multiple
  `workspaceFolders` — one per workbench root.
