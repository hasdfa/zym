/*
 * detectIndentation — guess a file's indentation style from its content, so an
 * opened file is edited with its own conventions rather than a fixed default.
 *
 * The heuristic (à la the `detect-indent` package): classify each indented line
 * as tab- or space-led; the majority wins the tabs-vs-spaces question. For space
 * indentation, tally the *change* in leading-space count between successive
 * indented lines (a step of 1–8) and take the most common — the indent unit.
 *
 * Tabs have no detectable display width (that's a render preference), so a tab
 * result carries no width; the caller falls back to the configured tab length.
 * Returns null when the file has no indentation to learn from.
 */
export interface Indentation {
  /** True ⇒ indent with spaces; false ⇒ indent with tabs. */
  useSpaces: boolean;
  /** Spaces per indent level (only meaningful when `useSpaces`). */
  width?: number;
}

export function detectIndentation(text: string): Indentation | null {
  let tabLines = 0;
  let spaceLines = 0;
  const stepVotes = new Map<number, number>();
  let prevWidth = 0;

  for (const line of text.split('\n')) {
    const lead = /^[\t ]*/.exec(line)![0];
    if (lead.length === line.length) continue; // blank / whitespace-only: ignore

    if (lead[0] === '\t') {
      tabLines++;
      prevWidth = 0; // don't mix tab indentation into the space-step votes
      continue;
    }
    if (lead[0] === ' ') {
      spaceLines++;
      const diff = lead.length - prevWidth;
      if (diff > 0 && diff <= 8) stepVotes.set(diff, (stepVotes.get(diff) ?? 0) + 1);
      prevWidth = lead.length;
    } else {
      prevWidth = 0; // a non-indented content line — measure the next indent from 0
    }
  }

  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { useSpaces: false };

  let width = 0;
  let best = 0;
  for (const [step, count] of stepVotes) {
    if (count > best) {
      best = count;
      width = step;
    }
  }
  if (width === 0) return null; // spaces present but no consistent step to learn
  return { useSpaces: true, width };
}
