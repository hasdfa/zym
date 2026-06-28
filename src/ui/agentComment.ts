/*
 * agentComment.ts — the canonical format for one "comment to agent" message,
 * shared by the diff surface (DiffView) and ordinary file editors (TextEditor).
 *
 * Both turn a cursor row / selection into the SAME shape — a `path:line`
 * reference, the targeted lines as a fenced block, then `On <locator>:` + the
 * user's text — differing only in the fence (`diff` hunk vs the file's language)
 * and the body (a unified-diff hunk vs plain code). Defining it once keeps the
 * two callers from drifting. See docs/text-editor/comment-to-agent.md.
 */

export interface AgentCommentParts {
  /** The `path:line` header's path, already relative to the relevant cwd. */
  rel: string;
  /** The line the comment is about (a diff's new-side line; an editor's file line). */
  line: number;
  /** Code-fence info string: `diff` for a diff hunk, the file's language id (or '') for plain code. */
  fence: string;
  /** The fenced body — a unified-diff hunk (diff) or the plain code lines (editor). */
  body: string;
  /** The location restated next to the text, e.g. `new L12, old L10` or `L12-14, cols 3-8`. */
  locator: string;
  /** The user's comment text (already trimmed). */
  comment: string;
}

/** One comment as an agent prompt: a `path:line` reference, the targeted lines as a fenced block,
 *  then `On <locator>:` + the comment — the location restated right next to the text so the agent
 *  knows exactly which line it's about (not just from the header). */
export function formatAgentComment(parts: AgentCommentParts): string {
  const { rel, line, fence, body, locator, comment } = parts;
  return [`${rel}:${line}`, '', '```' + fence, body, '```', '', `On ${locator}:`, comment].join('\n');
}
