import type { CreatedPr, PrDraft, PrVote, PullRequestSummary, Worktree } from "@nexura/shared";
import { git, stripAttribution } from "../workspace/git.ts";
import { azureRequest } from "./azure-client.ts";
import type { AzureRepo } from "./repo-remote.ts";

/** Azure DevOps rejects longer descriptions; the create-pr skill keeps them under this. */
export const PR_DESCRIPTION_MAX = 4000;

type CreatedResponse = { pullRequestId: number; title: string };

type ApiPullRequest = {
  pullRequestId: number;
  title: string;
  description?: string;
  createdBy?: { displayName?: string };
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  creationDate: string;
  lastMergeSourceCommit?: { commitId?: string };
};

/** Reviewer vote values of Azure DevOps. */
const VOTE_VALUE: Record<PrVote, number> = { approve: 10, approveWithSuggestions: 5, waitingForAuthor: -5 };

function pullRequestsPath(remote: AzureRepo): string {
  return `${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}/pullrequests`;
}

export function pullRequestUrl(remote: AzureRepo, prId: number): string {
  const project = encodeURIComponent(remote.project);
  const repository = encodeURIComponent(remote.repository);
  return `https://dev.azure.com/${remote.organization}/${project}/_git/${repository}/pullrequest/${prId}`;
}

const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, "");

/** Active PRs of the repo, newest first (up to 100). No tokens. */
export async function listActivePrs(remote: AzureRepo): Promise<PullRequestSummary[]> {
  const { value } = await azureRequest<{ value: ApiPullRequest[] }>(
    remote.organization,
    `${pullRequestsPath(remote)}?searchCriteria.status=active&$top=100`,
  );
  return value.map((pr) => ({
    id: pr.pullRequestId,
    title: pr.title,
    description: pr.description ?? "",
    author: pr.createdBy?.displayName ?? "",
    sourceBranch: branchName(pr.sourceRefName),
    targetBranch: branchName(pr.targetRefName),
    isDraft: Boolean(pr.isDraft),
    url: pullRequestUrl(remote, pr.pullRequestId),
    createdAt: pr.creationDate,
    headSha: pr.lastMergeSourceCommit?.commitId ?? "",
  }));
}

/** Casts the signed-in user's vote (the `az login` identity) on the PR. */
export async function vote(remote: AzureRepo, prId: number, value: PrVote): Promise<void> {
  const connection = await azureRequest<{ authenticatedUser?: { id?: string } }>(remote.organization, "_apis/connectionData", {
    apiVersion: "7.1-preview.1",
  });
  const reviewerId = connection.authenticatedUser?.id;
  if (!reviewerId) {
    throw new Error("Azure DevOps no devolvió tu identidad: no se puede votar");
  }
  await azureRequest(remote.organization, `${pullRequestsPath(remote)}/${prId}/reviewers/${encodeURIComponent(reviewerId)}`, {
    method: "PUT",
    body: { vote: VOTE_VALUE[value] },
  });
}

/** active | completed | abandoned. */
export async function getPrStatus(remote: AzureRepo, prId: number): Promise<string> {
  const pr = await azureRequest<{ status: string }>(remote.organization, `${pullRequestsPath(remote)}/${prId}`);
  return pr.status;
}

/** Pushes the branch and opens the PR, linking the work item on creation. */
export async function pushAndCreatePr(remote: AzureRepo, worktree: Worktree, draft: PrDraft): Promise<CreatedPr> {
  await git(worktree.path, ["push", "-u", "origin", worktree.branch]);
  const created = await azureRequest<CreatedResponse>(remote.organization, pullRequestsPath(remote), {
    method: "POST",
    body: {
      sourceRefName: `refs/heads/${worktree.branch}`,
      targetRefName: `refs/heads/${draft.target}`,
      title: draft.title,
      description: stripAttribution(draft.description).slice(0, PR_DESCRIPTION_MAX),
      isDraft: draft.isDraft,
      workItemRefs: draft.workItemId ? [{ id: String(draft.workItemId) }] : [],
    },
  });
  return { repo: worktree.repo, id: created.pullRequestId, title: created.title, url: pullRequestUrl(remote, created.pullRequestId) };
}
