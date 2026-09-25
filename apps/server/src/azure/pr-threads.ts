import type { CreatedPr, ReviewReply, ReviewThread, Worktree } from "@nexura/shared";
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
export async function getActiveThreads(remote: AzureRepo, worktree: Worktree, pr: CreatedPr): Promise<ReviewThread[]> {
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
