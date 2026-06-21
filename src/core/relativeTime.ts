/*
 * relativeTime — a coarse "N units ago" label for an epoch-seconds timestamp. Shared
 * formatting (git blame today, any future "… ago" need). Pass `now` (ms) to make it
 * deterministic in tests; it defaults to the current time.
 */

// Each entry is how many of the current unit make up the next one up.
const UNITS: Array<[size: number, name: string]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.35, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year'],
];

/** "3 days ago" / "just now" for `epochSeconds`; a 0/falsy timestamp is `'unknown'`.
 *  `now` is the reference time in ms (defaults to `Date.now()`). */
export function relativeTime(epochSeconds: number, now: number = Date.now()): string {
  if (!epochSeconds) return 'unknown';
  let value = Math.max(0, Math.floor(now / 1000 - epochSeconds));
  for (const [size, name] of UNITS) {
    if (value < size) {
      const n = Math.floor(value);
      return n <= 0 ? 'just now' : `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
    value /= size;
  }
  return 'just now';
}
