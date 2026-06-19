/*
 * process/runner-main.ts — the process-runner child (see runner.ts for the why).
 *
 * Why it exists: the main quilx process is a long-lived node-gtk process that
 * accrues a large resident set (1+ GiB). On this platform node spawns children
 * with a plain `fork()` (libuv's posix_spawn fast path isn't compiled into the
 * prebuilt binary), so every subprocess copies the parent's page tables — tens
 * of ms each at that RSS, and the git poller fires a steady stream of them.
 *
 * This child is a tiny, near-empty node process. The parent forks the BIG
 * process exactly once to launch it; thereafter every command runs by forking
 * THIS small process (~1 ms regardless of how large the editor grows). It reads
 * framed requests on stdin and writes framed responses on stdout (id-keyed, many
 * in flight) — the binary framing in codec.ts.
 *
 * Keep imports minimal — every module loaded here is pure overhead on the one
 * thing this process is for: staying small.
 */
import { execFile } from 'node:child_process';
import process from 'node:process';
import { FrameReader, FrameWriter, makeFrameParser } from './codec.ts';

const MAX_BUFFER = 64 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

interface RunResult {
  ok: boolean;
  code: number; // exit code, or -1 when killed by a signal
  stdout: Buffer;
  stderr: Buffer;
}

/** Run one command; `input` (if given) is written to its stdin (e.g. a patch). */
function run(file: string, args: string[], cwd: string, input: Buffer | null, cb: (r: RunResult) => void): void {
  let child;
  try {
    child = execFile(
      file,
      args,
      { cwd: cwd || undefined, encoding: 'buffer', maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
        cb({ ok: !err, code, stdout: (stdout as Buffer) ?? EMPTY, stderr: (stderr as Buffer) ?? EMPTY });
      },
    );
  } catch (e) {
    cb({ ok: false, code: -1, stdout: EMPTY, stderr: Buffer.from(String((e as Error)?.message ?? e), 'utf8') });
    return;
  }
  if (input != null) child.stdin?.end(input);
}

const onFrame = (body: Buffer): void => {
  const r = new FrameReader(body);
  const id = r.u32();
  const file = r.str();
  const cwd = r.str();
  const argc = r.u32();
  const args: string[] = [];
  for (let i = 0; i < argc; i++) args.push(r.str());
  const input = r.u8() ? r.bytes() : null;
  run(file, args, cwd, input, (res) => {
    const w = new FrameWriter();
    w.u32(id).u8(res.ok ? 1 : 0).i32(res.code).bytes(res.stdout).bytes(res.stderr);
    process.stdout.write(w.frame());
  });
};

process.stdin.on('data', makeFrameParser(onFrame));
// Parent gone (pipe closed): nothing left to serve — exit.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
