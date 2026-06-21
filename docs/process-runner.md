# Process runner

`src/process/runner.ts` (+ `runner-main.ts`, `codec.ts`) is the generic spawn
broker. The long-lived ~1.5 GB node-gtk process must never `fork()`: this Node's
libuv has no `posix_spawn` fast path, so fork cost scales with RSS (tens of
ms/spawn). Instead the parent forks one tiny child once, and that child runs
every command (~1 ms each).

- `runProcess({ file, args, cwd, input }, onDone)` is async-only.
- IPC is **binary, length-prefixed** (no JSON): stdout/stderr cross the pipe as
  raw bytes, up to 64 MiB.
- git (`git/cli.ts`) and gh (`github.ts`) both route through it; any subsystem
  that shells out reuses the same primitive.
- A direct-spawn fallback runs the command in-process if the child is down.

Tested in `src/process/runner.test.ts`.
