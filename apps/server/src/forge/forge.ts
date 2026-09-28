import type { CreatedPr, PrDraft, PrVote, PullRequestDetail, PullRequestSummary, ReviewReply, ReviewThread, RunRequest, Worktree } from "@nexura/shared";
import { azureGitEnv } from "../azure/azure-client.ts";
import * as azurePrs from "../azure/pull-requests.ts";
import * as azureThreads from "../azure/pr-threads.ts";
import * as githubPrs from "../github/pull-requests.ts";
import { assertOwnWorktree, git, stripAttribution } from "../workspace/git.ts";
import { repoRemoteOf, type RepoRemote } from "./remote.ts";
import type { ReviewPost } from "./review-post.ts";

/**
 * Pull requests and their review threads, on whichever provider the repo's origin remote
 * points to (Azure DevOps or GitHub). Plain REST/GraphQL, no Claude tokens.
 */

/** Kept short on every provider: Azure DevOps rejects longer descriptions. */
const PR_DESCRIPTION_MAX = azurePrs.PR_DESCRIPTION_MAX;

type ImplementSummary = { summary: string; filesChanged: string[]; prDescriptions?: { repo: string; description: string }[] };

export async function requireRemote(worktree: Pick<Worktree, "repo" | "repoPath">): Promise<RepoRemote> {
  const remote = await repoRemoteOf(worktree.repoPath);
  if (!remote) {
    throw new Error(`${worktree.repo}: el remote origin no es de Azure DevOps ni de GitHub`);
  }
  return remote;
}

/**
 * Deterministic PR draft (no tokens): title from the lead commit, description as prose +
 * bullets from what implement reported, following the create-pr skill. The ticket is linked
 * on creation (only when it lives on the PR's provider), never written in the editable body.
 * The user reviews and edits it before anything is pushed.
 */
export async function buildPrDraft(
  worktree: Worktree,
  target: string,
  implementSummaries: ImplementSummary[],
  request: Pick<RunRequest, "ticketId" | "ticketSource" | "ticketProject">,
): Promise<PrDraft> {
  const remote = await requireRemote(worktree);
  const subjects = (await git(worktree.path, ["log", "--format=%s", `${worktree.baseRef}..HEAD`])).split(/\r?\n/).filter(Boolean);
  const lead = subjects.at(-1) ?? worktree.branch;
  const summaries = implementSummaries.map((item) => stripAttribution(item.summary).trim()).filter(Boolean);
  const files = [...new Set(implementSummaries.flatMap((item) => item.filesChanged))];
  const bullets = (summaries.length > 1 ? summaries.slice(1) : subjects.slice(0, -1).reverse()).map((line) => `- ${line}`);
  const fallback = [
    summaries[0] ?? lead,
    bullets.join("\n"),
    files.length ? `Ficheros: ${files.map((file) => `\`${file}\``).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PR_DESCRIPTION_MAX);
  // The implementation agent knows the change and the repo's language conventions. Older
  // runs still have the deterministic draft above; every draft remains editable before push.
  const authored = implementSummaries.findLast((item) => item.prDescriptions?.some((entry) => entry.repo === worktree.repo && entry.description.trim()))
    ?.prDescriptions?.find((entry) => entry.repo === worktree.repo && entry.description.trim())?.description;
  const description = (authored ? stripAttribution(authored).trim() : "") || fallback;

  const ticketId = Number(request.ticketId) || undefined;
  const linked = ticketId !== undefined && (request.ticketSource ?? "azure") === remote.provider;
  const ownRepo = remote.provider === "github" ? `${remote.owner}/${remote.repo}`.toLowerCase() : "";
  const otherProject =
    linked && remote.provider === "github" && request.ticketProject && request.ticketProject.toLowerCase() !== ownRepo
      ? request.ticketProject
      : undefined;
  return {
    repo: worktree.repo,
    branch: worktree.branch,
    target,
    title: lead,
    description: description.slice(0, PR_DESCRIPTION_MAX),
    provider: remote.provider,
    workItemId: linked ? ticketId : undefined,
    workItemProject: otherProject,
    isDraft: false,
  };
}

/** Pushes the branch and opens the PR on the repo's provider, linking the ticket. */
export async function pushAndCreatePr(worktree: Worktree, draft: PrDraft): Promise<CreatedPr> {
  assertOwnWorktree(worktree);
  const remote = await requireRemote(worktree);
  return remote.provider === "azure"
    ? azurePrs.pushAndCreatePr(remote, worktree, draft)
    : githubPrs.pushAndCreatePr(remote, worktree, draft);
}

/** active | completed | abandoned (GitHub's open/merged/closed mapped to these). */
export async function getPrStatus(worktree: Worktree, prId: number): Promise<string> {
  const remote = await requireRemote(worktree);
  return remote.provider === "azure" ? azurePrs.getPrStatus(remote, prId) : githubPrs.getPrStatus(remote, prId);
}

/** Open PRs of the repo (GitHub `open`, Azure DevOps `active`), newest first. No tokens. */
export async function listPullRequests(repo: Pick<Worktree, "repo" | "repoPath">): Promise<PullRequestSummary[]> {
  const remote = await requireRemote(repo);
  return remote.provider === "azure" ? azurePrs.listActivePrs(remote) : githubPrs.listOpenPrs(remote);
}

/** Files, reviewers, labels and linked tickets of one PR (Revisiones' detail panel). No tokens. */
export async function getPullRequestDetail(repo: Pick<Worktree, "repo" | "repoPath">, prId: number): Promise<PullRequestDetail> {
  const remote = await requireRemote(repo);
  return remote.provider === "azure" ? azurePrs.getPrDetail(remote, prId) : githubPrs.getPrDetail(remote, prId);
}

/**
 * Posts the approved comments of a review, then the vote if one was chosen. GitHub takes it
 * all as one review on the reviewed commit; Azure DevOps as one thread per comment plus the
 * reviewer's vote. Nothing is signed: the text goes out as written, minus attribution lines.
 * `onPosted` hears of every comment once it is on the PR, so a failure halfway (Azure posts
 * them one by one) is not posted twice on retry.
 */
export async function publishReview(
  repo: Pick<Worktree, "repo" | "repoPath">,
  pr: { id: number; headSha: string },
  posts: ReviewPost[],
  vote?: PrVote,
  onPosted: (post: ReviewPost) => void = () => undefined,
): Promise<void> {
  const remote = await requireRemote(repo);
  const clean = posts.map((post) => ({ ...post, body: stripAttribution(post.body).trim() })).filter((post) => post.body);
  if (remote.provider === "github") {
    await githubPrs.postReview(remote, pr.id, pr.headSha, clean, vote);
    clean.forEach(onPosted);
    return;
  }
  for (const post of clean) {
    await azureThreads.createThread(remote, pr.id, post);
    onPosted(post);
  }
  if (vote) {
    await azurePrs.vote(remote, pr.id, vote);
  }
}

/** Active (unresolved) comment threads of a PR. */
export async function getActiveThreads(worktree: Pick<Worktree, "repo" | "repoPath">, pr: Pick<CreatedPr, "id">): Promise<ReviewThread[]> {
  const remote = await requireRemote(worktree);
  return remote.provider === "azure"
    ? azureThreads.getActiveThreads(remote, worktree, pr)
    : githubPrs.getActiveThreads(remote, worktree, pr);
}

/** Replies in the thread and resolves it when the reply says it was fixed (or won't be). */
export async function replyToThread(worktree: Worktree, prId: number, reply: ReviewReply): Promise<void> {
  const remote = await requireRemote(worktree);
  await (remote.provider === "azure" ? azureThreads.replyToThread(remote, prId, reply) : githubPrs.replyToThread(remote, prId, reply));
}

export async function pushBranch(worktree: Worktree): Promise<void> {
  assertOwnWorktree(worktree);
  await git(worktree.path, ["push", "origin", worktree.branch], azureGitEnv());
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
