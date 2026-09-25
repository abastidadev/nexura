import type { CreatedPr, PrDraft, ReviewReply, ReviewThread, Worktree } from "@nexura/shared";
import { git, stripAttribution } from "../workspace/git.ts";
import { githubGraphql, githubRequest } from "./github-client.ts";
import { repoApiPath, type GithubRepo } from "./repo-remote.ts";

/** GitHub rejects PR bodies above this many characters. */
const PR_BODY_MAX = 65_000;

/** Body as created: the approved description plus the closing keyword that links the issue. */
export function prBody(draft: Pick<PrDraft, "description" | "workItemId" | "workItemProject">): string {
  const description = stripAttribution(draft.description).trim();
  const closes = draft.workItemId ? `Closes ${draft.workItemProject ?? ""}#${draft.workItemId}` : "";
  return [description.slice(0, PR_BODY_MAX - closes.length - 2), closes].filter(Boolean).join("\n\n");
}

/** Pushes the branch and opens the PR; the issue is linked with `Closes #n` (closed on merge). */
export async function pushAndCreatePr(remote: GithubRepo, worktree: Worktree, draft: PrDraft): Promise<CreatedPr> {
  await git(worktree.path, ["push", "-u", "origin", worktree.branch]);
  const created = await githubRequest<{ number: number; title: string; html_url: string }>(`${repoApiPath(remote)}/pulls`, {
    method: "POST",
    body: { title: draft.title, head: worktree.branch, base: draft.target, body: prBody(draft), draft: draft.isDraft },
  });
  return { repo: worktree.repo, id: created.number, title: created.title, url: created.html_url };
}

/** Mapped to the Azure DevOps names the watcher uses: active | completed (merged) | abandoned (closed). */
export async function getPrStatus(remote: GithubRepo, prId: number): Promise<string> {
  const pr = await githubRequest<{ state: string; merged?: boolean }>(`${repoApiPath(remote)}/pulls/${prId}`);
  if (pr.state === "open") {
    return "active";
  }
  return pr.merged ? "completed" : "abandoned";
}

type ApiThread = {
  id: string;
  isResolved: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  comments: { nodes: { databaseId: number; body: string; author?: { login?: string } | null }[] };
};

const THREADS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            originalLine
            comments(first: 50) { nodes { databaseId body author { login } } }
          }
        }
      }
    }
  }`;

const RESOLVE_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }`;

async function reviewThreads(remote: GithubRepo, prId: number): Promise<ApiThread[]> {
  const data = await githubGraphql<{ repository: { pullRequest: { reviewThreads: { nodes: ApiThread[] } } | null } | null }>(
    THREADS_QUERY,
    { owner: remote.owner, name: remote.repo, number: prId },
  );
  return data.repository?.pullRequest?.reviewThreads.nodes ?? [];
}

/**
 * Unresolved review threads of the PR (code comments). Its id is the first comment's id,
 * which is also what a reply is posted to. Conversation comments have no resolved state,
 * so they are not tracked. No tokens.
 */
export async function getActiveThreads(remote: GithubRepo, worktree: Worktree, pr: CreatedPr): Promise<ReviewThread[]> {
  return (await reviewThreads(remote, pr.id))
    .filter((thread) => !thread.isResolved && thread.comments.nodes.length > 0)
    .map((thread) => ({
      repo: worktree.repo,
      prId: pr.id,
      threadId: thread.comments.nodes[0]!.databaseId,
      filePath: thread.path ?? undefined,
      line: thread.line ?? thread.originalLine ?? undefined,
      comments: thread.comments.nodes
        .filter((comment) => comment.body.trim())
        .map((comment) => ({ author: comment.author?.login ?? "", content: comment.body.trim() })),
    }))
    .filter((thread) => thread.comments.length > 0);
}

/** Replies in the thread and, when fixed (or won't be), resolves it: GitHub has no separate wontFix status. */
export async function replyToThread(remote: GithubRepo, prId: number, reply: ReviewReply): Promise<void> {
  await githubRequest(`${repoApiPath(remote)}/pulls/${prId}/comments/${reply.threadId}/replies`, {
    method: "POST",
    body: { body: reply.reply },
  });
  if (reply.action === "answered") {
    return;
  }
  const thread = (await reviewThreads(remote, prId)).find((candidate) => candidate.comments.nodes[0]?.databaseId === reply.threadId);
  if (thread && !thread.isResolved) {
    await githubGraphql(RESOLVE_MUTATION, { threadId: thread.id });
  }
}
