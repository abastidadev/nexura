/**
 * A review comment ready to post. With `path` + lines it is anchored on the PR's diff (the
 * orchestrator only anchors lines inside it); without them it is a comment on the PR as a whole.
 */
export type ReviewPost = {
  path?: string;
  startLine?: number;
  endLine?: number;
  /** Columns (1-based) of the first non-blank character of the first line and one past the end of the last one: Azure DevOps rejects offset 0. */
  startOffset?: number;
  endOffset?: number;
  body: string;
  /** The review comment it comes from, to record it as posted. */
  commentId?: number;
};

export function isInlinePost(post: ReviewPost): post is ReviewPost & { path: string; startLine: number } {
  return Boolean(post.path && post.startLine);
}
