/*
 * Picker ranking benchmark — not a correctness test. Skipped unless BENCH is
 * set, so it never runs in CI / the normal `node --test` sweep. Run with:
 *
 *   BENCH=1 node --test src/ui/fuzzyMatch.bench.test.ts
 *
 * It builds a synthetic 20k-path pool (the picker's MAX_FILES) and median-times
 * `rank()` for a spread of query shapes. Compare the logged numbers before and
 * after a change on the same machine; wall-time is too noisy to assert. The
 * specific-query and zero-match rows should move the most (the typo-gate +
 * prepared-cache wins).
 */
import { test } from 'node:test';
import { rank, type PickerItem } from './Picker.ts';

const SEGMENTS = ['src', 'ui', 'core', 'util', 'lib', 'app', 'git', 'editor', 'view', 'model', 'controller', 'service'];
const NAMES = ['Picker', 'index', 'helpers', 'config', 'main', 'status', 'parser', 'render', 'handler', 'store', 'widget', 'client'];
const EXTS = ['.ts', '.tsx', '.js', '.json', '.css'];

// Deterministic synthetic paths (no Math.random — stable across runs).
function buildPool(n: number): PickerItem[] {
  const items: PickerItem[] = [];
  for (let i = 0; i < n; i++) {
    const a = SEGMENTS[i % SEGMENTS.length];
    const b = SEGMENTS[(i * 7) % SEGMENTS.length];
    const name = NAMES[(i * 13) % NAMES.length];
    const ext = EXTS[(i * 3) % EXTS.length];
    const rel = `${a}/${b}/${name}${i}${ext}`;
    const dirEnd = rel.length - (`${name}${i}${ext}`).length;
    items.push({ value: rel, text: rel, boostFrom: dirEnd });
  }
  return items;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

test('rank() throughput at 20k items', { skip: !process.env.BENCH }, () => {
  const items = buildPool(20_000);
  const weight = () => 0; // frecency-style bonus path, but constant
  const queries = ['', 'a', 'src', 'Picker.ts', 'zzqq', 'Pickr'];
  const RUNS = 12;
  // Warm up (JIT + first-keystroke prepared-cache fill).
  for (const q of queries) rank(q, items, weight);

  console.log(`\nrank() median over ${RUNS} runs, ${items.length} items:`);
  for (const q of queries) {
    const times: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      const out = rank(q, items, weight);
      times.push(performance.now() - t0);
      if (r === 0) console.log(`  ${JSON.stringify(q).padEnd(12)} → ${out.length} matches`);
    }
    console.log(`  ${JSON.stringify(q).padEnd(12)} ${median(times).toFixed(2)} ms`);
  }
});
