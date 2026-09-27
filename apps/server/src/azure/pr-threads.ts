import type { CreatedPr, ReviewReply, ReviewThread, Worktree } from "@nexura/shared";
import { isInlinePost, type ReviewPost } from "../forge/review-post.ts";
import { azureRequest } from "./azure-client.ts";
import type { AzureRepo } from "./repo-remote.ts";

type ApiThread = {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } } | null;
  comments: { id: number; content?: string; commentType?: string; isDeleted?: boolean; author?: { displayName?: string } }[];
};

/** Thread statuses Azure DevOps uses, and the one a fixed thread moves to. */
const ACTIVE_STATUSES = new Set(["active", "pending"]);
const STATUS_BY_ACTION: Record<ReviewReply["action"], string | undefined> = {
  fixed: "fixed",
  wontFix: "wontFix",
  answered: undefined,
};

function threadsPath(remote: AzureRepo, prId: number): string {
  return `${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}/pullRequests/${prId}/threads`;
}

/** Active human comment threads of a PR (system/bot and resolved threads are skipped). No tokens. */
export async function getActiveThreads(remote: AzureRepo, worktree: Pick<Worktree, "repo">, pr: Pick<CreatedPr, "id">): Promise<ReviewThread[]> {
  const { value } = await azureRequest<{ value: ApiThread[] }>(remote.organization, threadsPath(remote, pr.id));
  return value
    .filter((thread) => !thread.isDeleted && ACTIVE_STATUSES.has(thread.status ?? ""))
    .map((thread) => ({
      repo: worktree.repo,
      prId: pr.id,
      threadId: thread.id,
      filePath: thread.threadContext?.filePath,
      line: thread.threadContext?.rightFileStart?.line,
      comments: thread.comments
        .filter((comment) => !comment.isDeleted && comment.commentType !== "system" && comment.content?.trim())
        .map((comment) => ({ author: comment.author?.displayName ?? "", content: comment.content!.trim() })),
    }))
    .filter((thread) => thread.comments.length > 0);
}

/**
 * Opens an active thread: anchored on the new file's lines when the post has them (the path
 * repo-root-absolute, offsets never 0, as the pr-mechanics skill requires), else on the PR.
 */
export async function createThread(remote: AzureRepo, prId: number, post: ReviewPost): Promise<void> {
  const threadContext = isInlinePost(post)
    ? {
        filePath: `/${post.path.replace(/^\/+/, "")}`,
        rightFileStart: { line: post.startLine, offset: Math.max(1, post.startOffset ?? 1) },
        rightFileEnd: { line: post.endLine ?? post.startLine, offset: Math.max(1, post.endOffset ?? 1) },
      }
    : undefined;
  await azureRequest(remote.organization, threadsPath(remote, prId), {
    method: "POST",
    body: {
      comments: [{ parentCommentId: 0, content: post.body, commentType: "text" }],
      status: "active",
      ...(threadContext ? { threadContext } : {}),
    },
  });
}

/** Replies in the thread and, when the change fixed it, moves it to `fixed` (or `wontFix`). */
export async function replyToThread(remote: AzureRepo, prId: number, reply: ReviewReply): Promise<void> {
  const path = `${threadsPath(remote, prId)}/${reply.threadId}`;
  await azureRequest(remote.organization, `${path}/comments`, {
    method: "POST",
    body: { parentCommentId: 1, content: reply.reply, commentType: "text" },
  });
  const status = STATUS_BY_ACTION[reply.action];
  if (status) {
    await azureRequest(remote.organization, path, { method: "PATCH", body: { status } });
  }
}
