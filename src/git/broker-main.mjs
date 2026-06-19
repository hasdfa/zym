/*
 * broker-main.mjs — the git broker child process.
 *
 * Why it exists: the main quilx process is a long-lived node-gtk process that
 * accrues a large resident set (1+ GiB). On this platform node spawns children
 * with a plain `fork()` (libuv's posix_spawn fast path isn't compiled into the
 * prebuilt binary), so every `git` invocation copies the parent's page tables —
 * tens of ms each at that RSS, and the git poller fires a steady stream of them.
 *
 * This broker is a tiny, near-empty node process. The parent forks the BIG
 * process exactly once to launch it; thereafter every `git` runs by forking THIS
 * small process (~1 ms regardless of how large the editor grows). It speaks two
 * framed channels so it can serve both of `git/cli.ts`'s shapes:
 *
 *   - async: requests on stdin, responses on stdout (id-keyed; many in flight).
 *   - sync : requests on a request FIFO, responses on a response FIFO (serial,
 *            no id — the parent blocks on each round trip, so only one is ever
 *            outstanding). Backs the synchronous `gitSync`, whose callers cannot
 *            await (synchronous getters, `when:` predicates).
 *
 * Framing on every channel: a 4-byte little-endian length prefix + a UTF-8 JSON
 * body. Request: { id?, cwd, args, input? }. Response: { id?, ok, stdout, stderr }.
 *
 * Keep imports minimal — every module loaded here is pure overhead on the one
 * thing this process is for: staying small.
 */
import { execFile } from 'node:child_process';
import { createReadStream, openSync, writeSync } from 'node:fs';
import process from 'node:process';

const MAX_BUFFER = 64 * 1024 * 1024;
const [reqFifo, respFifo] = process.argv.slice(2);

/** Run one git invocation; `input` (if given) is written to its stdin (hunk patches). */
function runGit(cwd, args, input, cb) {
  let child;
  try {
    child = execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      cb({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  } catch (e) {
    cb({ ok: false, stdout: '', stderr: String(e && e.message || e) });
    return;
  }
  if (input != null) child.stdin?.end(input);
}

/** Encode a message as a length-prefixed frame. */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** A stateful parser that calls `onMessage` for each complete frame in a byte stream. */
function makeParser(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { continue; }
      onMessage(msg);
    }
  };
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, null);
}

// --- async channel: stdin → stdout (id-keyed) --------------------------------
const parseStdin = makeParser((msg) => {
  runGit(msg.cwd, msg.args, msg.input, (res) => {
    process.stdout.write(frame({ id: msg.id, ...res }));
  });
});
process.stdin.on('data', parseStdin);
// Parent gone (pipe closed): nothing left to serve — exit.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

// --- sync channel: reqFifo → respFifo (serial, no id) ------------------------
// Open both FIFOs O_RDWR ('r+'): on Linux that returns immediately instead of
// blocking until the peer opens the other end, so there is no startup open-order
// deadlock. We only ever read the request FIFO and write the response FIFO.
if (reqFifo && respFifo) {
  const respFd = openSync(respFifo, 'r+');
  const reqStream = createReadStream(null, { fd: openSync(reqFifo, 'r+') });
  const parseReq = makeParser((msg) => {
    runGit(msg.cwd, msg.args, msg.input, (res) => writeAll(respFd, frame(res)));
  });
  reqStream.on('data', parseReq);
}
