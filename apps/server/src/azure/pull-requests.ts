import type { CreatedPr, PrDraft, PrFileStatus, PrReviewerState, PrVote, PullRequestDetail, PullRequestSummary, Worktree } from "@nexura/shared";
import { git, stripAttribution } from "../workspace/git.ts";
import { azureGitEnv, azureRequest } from "./azure-client.ts";
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
  await git(worktree.path, ["push", "-u", "origin", worktree.branch], azureGitEnv());
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

type ApiPullRequestDetail = {
  reviewers?: { displayName?: string; vote?: number }[];
  labels?: { name: string; active?: boolean }[];
};

type ApiChange = { changeType?: string; item?: { path?: string; isFolder?: boolean; gitObjectType?: string } };

const REVIEWER_STATE: Record<number, PrReviewerState> = { 10: "approved", 5: "suggestions", 0: "pending", [-5]: "waiting", [-10]: "rejected" };

function fileStatus(changeType = ""): PrFileStatus {
  if (changeType.includes("add")) {
    return "added";
  }
  if (changeType.includes("delete")) {
    return "deleted";
  }
  return changeType.includes("rename") ? "renamed" : "modified";
}

/**
 * What the PR changes and who looks at it: files of its latest iteration (Azure DevOps gives
 * no line counts), commits (up to 100), labels, reviewers' votes and linked work items. No tokens.
 */
export async function getPrDetail(remote: AzureRepo, prId: number): Promise<PullRequestDetail> {
  const base = `${pullRequestsPath(remote)}/${prId}`;
  const [pr, iterations, commits, links, labels] = await Promise.all([
    azureRequest<ApiPullRequestDetail>(remote.organization, base),
    azureRequest<{ value: { id: number }[] }>(remote.organization, `${base}/iterations`),
    azureRequest<{ value: unknown[]; count?: number }>(remote.organization, `${base}/commits?$top=100`),
    azureRequest<{ value: { id: string }[] }>(remote.organization, `${base}/workitems`),
    // A single PR comes without its labels: they have their own endpoint.
    azureRequest<{ value: { name: string; active?: boolean }[] }>(remote.organization, `${base}/labels`).catch(() => ({ value: [] as { name: string; active?: boolean }[] })),
  ]);
  const last = iterations.value.at(-1)?.id;
  const [changes, workItems] = await Promise.all([
    last === undefined
      ? Promise.resolve({ changeEntries: [] as ApiChange[] })
      : azureRequest<{ changeEntries: ApiChange[] }>(remote.organization, `${base}/iterations/${last}/changes?$top=2000&$compareTo=0`),
    links.value.length
      ? azureRequest<{ value: { id: number; fields: Record<string, unknown> }[] }>(
          remote.organization,
          `_apis/wit/workitems?ids=${links.value.map((link) => encodeURIComponent(link.id)).join(",")}&fields=System.Title`,
        ).catch(() => ({ value: [] }))
      : Promise.resolve({ value: [] }),
  ]);
  const titles = new Map(workItems.value.map((item) => [String(item.id), String(item.fields["System.Title"] ?? "")]));
  const files = changes.changeEntries
    .filter((change) => change.item?.path && !change.item.isFolder && change.item.gitObjectType !== "tree")
    .map((change) => ({ path: change.item!.path!.replace(/^\//, ""), status: fileStatus(change.changeType) }));
  return {
    files,
    changedFiles: files.length,
    commits: commits.count ?? commits.value.length,
    labels: (labels.value?.length ? labels.value : (pr.labels ?? [])).filter((label) => label.active !== false).map((label) => label.name),
    reviewers: (pr.reviewers ?? []).map((reviewer) => ({ name: reviewer.displayName ?? "", state: REVIEWER_STATE[reviewer.vote ?? 0] ?? "pending" })),
    tickets: links.value.map((link) => ({
      id: link.id,
      title: titles.get(link.id) ?? "",
      url: `https://dev.azure.com/${remote.organization}/${encodeURIComponent(remote.project)}/_workitems/edit/${link.id}`,
    })),
  };
}
