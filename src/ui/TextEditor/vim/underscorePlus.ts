/*
 * underscorePlus — the sliver of the `underscore-plus` package the vendored
 * vim-mode-plus core actually uses (reached via `vimState._`).
 *
 * Upstream pulls in the whole library; we provide only the handful of helpers
 * the ported operations call, growing this as more of the core comes online.
 */

/** Escape a string for literal use inside a `RegExp`. */
export function escapeRegExp(string: string): string {
  return string ? string.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') : '';
}

/**
 * Split `array` into `[passed, failed]` by `predicate` (underscore-plus order:
 * elements for which the predicate is truthy come first).
 */
export function partition<T>(array: T[], predicate: (value: T) => unknown): [T[], T[]] {
  const passed: T[] = [];
  const failed: T[] = [];
  for (const value of array) (predicate(value) ? passed : failed).push(value);
  return [passed, failed];
}

export default { escapeRegExp, partition };
