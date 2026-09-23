import type { CreatedPr, ReviewReply, ReviewThread, Worktree } from "@nexura/shared";
import { git } from "../workspace/git.ts";
import { azureRequest } from "./azure-client.ts";
import { azureRepoOf, type AzureRepo } from "./repo-remote.ts";

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

async function remoteOf(worktree: Worktree): Promise<AzureRepo> {
  const remote = await azureRepoOf(worktree.repoPath);
  if (!remote) {
    throw new Error(`${worktree.repo}: el remote origin no es de Azure DevOps`);
  }
  return remote;
}

function threadsPath(remote: AzureRepo, prId: number): string {
  return `${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}/pullRequests/${prId}/threads`;
}

/** Active human comment threads of a PR (system/bot and resolved threads are skipped). No tokens. */
export async function getActiveThreads(worktree: Worktree, pr: CreatedPr): Promise<ReviewThread[]> {
  const remote = await remoteOf(worktree);
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
export async function replyToThread(worktree: Worktree, prId: number, reply: ReviewReply): Promise<void> {
  const remote = await remoteOf(worktree);
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

export async function pushBranch(worktree: Worktree): Promise<void> {
  await git(worktree.path, ["push", "origin", worktree.branch]);
}

/** Threads as the prompt reads them. */
export function threadsToText(threads: ReviewThread[]): string {
  return threads
    .map((thread) => {
      const where = thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ""}` : "comentario general";
      const comments = thread.comments.map((comment) => `  - ${comment.author}: ${comment.content.replace(/\n+/g, " ")}`).join("\n");
      return `- repo \`${thread.repo}\` · thread ${thread.threadId} · ${where}\n${comments}`;
    })
    .join("\n");
}
