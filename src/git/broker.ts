/*
 * broker.ts — client side of the git broker (see broker-main.mjs for the why).
 *
 * Routes every `git` invocation through a small long-lived child process so the
 * giant node-gtk parent never `fork()`s (fork cost scales with the parent's RSS).
 * Exposes the two shapes `git/cli.ts` needs:
 *
 *   - brokerGit(cwd, args, onDone, input?) — async (stdin/stdout framing).
 *   - brokerGitSync(cwd, args, input?)     — synchronous (FIFO round trip).
 *
 * Robustness: the broker is lazily (re)spawned on first use and after a crash.
 * If anything about the broker path is unavailable (spawn failed, sync FIFO I/O
 * error), the calls fall back to spawning `git` directly from this process — the
 * pre-broker behaviour — so git never silently stops working; we only lose the
 * fork-cost win for those calls.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as Path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const BROKER_MAIN = fileURLToPath(new URL('./broker-main.mjs', import.meta.url));

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

let child: ChildProcess | null = null;
let fifoDir: string | null = null;
let reqFd = -1;
let respFd = -1;
let nextId = 1;
const pending = new Map<number, (res: GitResult) => void>();
let stdoutBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

// Pipe stdio are net.Sockets at runtime (so they have ref/unref), but they're
// typed as the base Writable/Readable; narrow before toggling the loop ref.
type Refable = { ref(): void; unref(): void };
function refable(s: unknown): Refable | undefined {
  return s && typeof (s as Refable).unref === 'function' ? (s as Refable) : undefined;
}

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Lazily (re)spawn the broker and (re)establish both channels. No-op when healthy. */
function ensureBroker(): boolean {
  if (child && child.exitCode === null && !child.killed) return true;
  teardown();
  try {
    fifoDir = mkdtempSync(Path.join(os.tmpdir(), 'quilx-git-broker-'));
    const reqFifo = Path.join(fifoDir, 'req');
    const respFifo = Path.join(fifoDir, 'resp');
    execFileSync('mkfifo', [reqFifo, respFifo]); // one-time; node has no mkfifo
    child = spawn(process.execPath, [BROKER_MAIN, reqFifo, respFifo], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.on('error', () => teardown());
    child.on('exit', () => {
      // Fail any in-flight async calls; the next call respawns.
      for (const cb of pending.values()) cb({ ok: false, stdout: '', stderr: 'git broker exited' });
      pending.clear();
      teardown();
    });
    child.stdout!.on('data', onStdout);
    // Don't let the broker keep the host's event loop alive: the editor runs the
    // GLib loop forever, but short-lived processes (tests, scripts) must still be
    // able to exit. The child handle + stdin stay unref'd; stdout is ref'd only
    // while async requests are in flight (see brokerGit / onStdout). The sync FIFO
    // fds are plain fds (not libuv handles), so they never hold the loop.
    child.unref();
    refable(child.stdin)?.unref();
    refable(child.stdout)?.unref();
    // O_RDWR ('r+') so these opens don't block on the peer (see broker-main.mjs).
    reqFd = openSync(reqFifo, 'r+');
    respFd = openSync(respFifo, 'r+');
    return true;
  } catch {
    teardown();
    return false;
  }
}

function teardown(): void {
  for (const fd of [reqFd, respFd]) {
    if (fd >= 0) { try { closeSync(fd); } catch {} }
  }
  reqFd = respFd = -1;
  if (child) {
    child.stdout?.removeAllListeners();
    try { child.kill(); } catch {}
    child = null;
  }
  if (fifoDir) { try { rmSync(fifoDir, { recursive: true, force: true }); } catch {} fifoDir = null; }
  stdoutBuf = Buffer.alloc(0);
}

function onStdout(chunk: Buffer): void {
  stdoutBuf = stdoutBuf.length ? Buffer.concat([stdoutBuf, chunk]) : chunk;
  while (stdoutBuf.length >= 4) {
    const len = stdoutBuf.readUInt32LE(0);
    if (stdoutBuf.length < 4 + len) break;
    const body = stdoutBuf.subarray(4, 4 + len);
    stdoutBuf = stdoutBuf.subarray(4 + len);
    let msg: { id: number } & GitResult;
    try { msg = JSON.parse(body.toString('utf8')); } catch { continue; }
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      if (pending.size === 0) refable(child?.stdout)?.unref(); // no async work left: release the loop
      cb({ ok: msg.ok, stdout: msg.stdout, stderr: msg.stderr });
    }
  }
}

/** Async git via the broker (falls back to a direct spawn if the broker is down). */
export function brokerGit(
  cwd: string,
  args: string[],
  onDone: (ok: boolean, stdout: string, stderr: string) => void,
  input?: string,
): void {
  if (!ensureBroker() || !child?.stdin) {
    directGit(cwd, args, onDone, input);
    return;
  }
  const id = nextId++;
  if (pending.size === 0) refable(child.stdout)?.ref(); // keep the loop alive until the reply lands
  pending.set(id, (res) => onDone(res.ok, res.stdout, res.stderr));
  child.stdin.write(frame({ id, cwd, args, input }));
}

/** Synchronous git via the broker's FIFO round trip (falls back to execFileSync). */
export function brokerGitSync(cwd: string, args: string[], input?: string): GitResult {
  if (!ensureBroker()) return directSync(cwd, args, input);
  try {
    writeFrameSync(reqFd, { cwd, args, input });
    return readFrameSync(respFd);
  } catch {
    // The broker is wedged or gone — drop it and serve this call directly so the
    // caller still gets an answer; the next call will respawn a fresh broker.
    teardown();
    return directSync(cwd, args, input);
  }
}

// Best-effort cleanup so a hard exit doesn't leak the broker child or its FIFO
// temp dir. (The broker also self-exits on stdin EOF when the parent dies.)
process.on('exit', () => teardown());

// --- sync framing over the FIFO ----------------------------------------------

function writeFrameSync(fd: number, obj: unknown): void {
  const buf = frame(obj);
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, null);
}

function readFrameSync(fd: number): GitResult {
  const lenBuf = readExactSync(fd, 4);
  const len = lenBuf.readUInt32LE(0);
  const body = readExactSync(fd, len);
  const msg = JSON.parse(body.toString('utf8')) as GitResult;
  return { ok: msg.ok, stdout: msg.stdout, stderr: msg.stderr };
}

function readExactSync(fd: number, n: number): Buffer {
  const buf = Buffer.allocUnsafe(n);
  let off = 0;
  while (off < n) {
    const r = readSync(fd, buf, off, n - off, null);
    if (r === 0) throw new Error('git broker EOF');
    off += r;
  }
  return buf;
}

// --- direct (no-broker) fallbacks: spawn git from this process ---------------

function directGit(
  cwd: string,
  args: string[],
  onDone: (ok: boolean, stdout: string, stderr: string) => void,
  input?: string,
): void {
  const c = execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
    onDone(!err, stdout ?? '', stderr ?? '');
  });
  if (input != null) c.stdin?.end(input);
}

function directSync(cwd: string, args: string[], input?: string): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      input,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String((e as Error).message ?? e) };
  }
}
