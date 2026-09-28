import type { CreatedPr, PrDraft, PrFileStatus, PrReviewerState, PrVote, PullRequestDetail, PullRequestSummary, ReviewReply, ReviewThread, Worktree } from "@nexura/shared";
import { isInlinePost, type ReviewPost } from "../forge/review-post.ts";
import { git, stripAttribution } from "../workspace/git.ts";
import { githubGraphql, githubRequest } from "./github-client.ts";
import { repoApiPath, type GithubRepo } from "./repo-remote.ts";

type ApiPull = {
  number: number;
  title: string;
  body?: string | null;
  user?: { login?: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  draft?: boolean;
  html_url: string;
  created_at: string;
};

/** Open PRs of the repo, newest first (up to 100). No tokens. */
export async function listOpenPrs(remote: GithubRepo): Promise<PullRequestSummary[]> {
  const pulls = await githubRequest<ApiPull[]>(`${repoApiPath(remote)}/pulls?state=open&sort=created&direction=desc&per_page=100`);
  return pulls.map((pull) => ({
    id: pull.number,
    title: pull.title,
    description: pull.body ?? "",
    author: pull.user?.login ?? "",
    sourceBranch: pull.head.ref,
    targetBranch: pull.base.ref,
    isDraft: Boolean(pull.draft),
    url: pull.html_url,
    createdAt: pull.created_at,
    headSha: pull.head.sha,
  }));
}

type ApiPullDetail = ApiPull & {
  additions?: number;
  deletions?: number;
  commits?: number;
  changed_files?: number;
  labels?: { name: string }[];
  requested_reviewers?: { login?: string }[];
};

type ApiFile = { filename: string; status: string; additions?: number; deletions?: number };

const FILE_STATUS: Record<string, PrFileStatus> = { added: "added", removed: "deleted", renamed: "renamed" };

const REVIEW_STATE: Record<string, PrReviewerState> = { APPROVED: "approved", CHANGES_REQUESTED: "waiting", COMMENTED: "commented" };

const LINKED_ISSUES_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 20) { nodes { number title url } }
      }
    }
  }`;

/**
 * What the PR changes and who looks at it: files (the first 100), line counts, labels,
 * reviewers (their latest review, or pending when requested) and the issues it closes. No tokens.
 */
export async function getPrDetail(remote: GithubRepo, prId: number): Promise<PullRequestDetail> {
  const base = `${repoApiPath(remote)}/pulls/${prId}`;
  const [pull, files, reviews, linked] = await Promise.all([
    githubRequest<ApiPullDetail>(base),
    githubRequest<ApiFile[]>(`${base}/files?per_page=100`),
    githubRequest<{ user?: { login?: string } | null; state: string }[]>(`${base}/reviews?per_page=100`),
    // Linked issues are a nice-to-have: without them the rest still shows.
    githubGraphql<{ repository: { pullRequest: { closingIssuesReferences?: { nodes: { number: number; title: string; url: string }[] } } | null } | null }>(
      LINKED_ISSUES_QUERY,
      { owner: remote.owner, name: remote.repo, number: prId },
    ).catch(() => undefined),
  ]);
  const reviewers = new Map<string, PrReviewerState>();
  for (const review of reviews) {
    const state = REVIEW_STATE[review.state];
    const login = review.user?.login;
    // A later comment does not undo an approval or a change request.
    if (login && state && !(state === "commented" && reviewers.has(login))) {
      reviewers.set(login, state);
    }
  }
  for (const requested of pull.requested_reviewers ?? []) {
    if (requested.login) {
      reviewers.set(requested.login, "pending");
    }
  }
  return {
    files: files.map((file) => ({ path: file.filename, status: FILE_STATUS[file.status] ?? "modified", additions: file.additions, deletions: file.deletions })),
    changedFiles: pull.changed_files ?? files.length,
    additions: pull.additions,
    deletions: pull.deletions,
    commits: pull.commits,
    labels: (pull.labels ?? []).map((label) => label.name),
    reviewers: [...reviewers].map(([name, state]) => ({ name, state })),
    tickets: (linked?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).map((issue) => ({ id: String(issue.number), title: issue.title, url: issue.url })),
  };
}

/** GitHub has no "approved with suggestions": it is an approval that carries the comments. */
const REVIEW_EVENT: Record<PrVote, string> = { approve: "APPROVE", approveWithSuggestions: "APPROVE", waitingForAuthor: "REQUEST_CHANGES" };

/**
 * Posts one review on the reviewed commit: the anchored comments on their lines, the PR-level
 * ones in its body, and the vote as its event (COMMENT when there is none).
 */
export async function postReview(remote: GithubRepo, prId: number, headSha: string, posts: ReviewPost[], vote?: PrVote): Promise<void> {
  const inline = posts.filter(isInlinePost);
  const general = posts.filter((post) => !isInlinePost(post)).map((post) => post.body);
  const event = vote ? REVIEW_EVENT[vote] : "COMMENT";
  // GitHub requires a body to request changes; a comment-only review needs something to say.
  const body = general.join("\n\n") || (event === "REQUEST_CHANGES" ? "Please see the inline comments." : "");
  if (event === "COMMENT" && !body && inline.length === 0) {
    return;
  }
  await githubRequest(`${repoApiPath(remote)}/pulls/${prId}/reviews`, {
    method: "POST",
    body: {
      commit_id: headSha,
      event,
      ...(body ? { body } : {}),
      comments: inline.map((post) => {
        const end = post.endLine && post.endLine > post.startLine ? post.endLine : post.startLine;
        return {
          path: post.path,
          line: end,
          side: "RIGHT",
          ...(end > post.startLine ? { start_line: post.startLine, start_side: "RIGHT" } : {}),
          body: post.body,
        };
      }),
    },
  });
}

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
export async function getActiveThreads(remote: GithubRepo, worktree: Pick<Worktree, "repo">, pr: Pick<CreatedPr, "id">): Promise<ReviewThread[]> {
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
