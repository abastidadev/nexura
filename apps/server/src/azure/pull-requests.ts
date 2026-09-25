import type { CreatedPr, PrDraft, Worktree } from "@nexura/shared";
import { git, stripAttribution } from "../workspace/git.ts";
import { azureRequest } from "./azure-client.ts";
import type { AzureRepo } from "./repo-remote.ts";

/** Azure DevOps rejects longer descriptions; the create-pr skill keeps them under this. */
export const PR_DESCRIPTION_MAX = 4000;

type CreatedResponse = { pullRequestId: number; title: string };

function pullRequestsPath(remote: AzureRepo): string {
  return `${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}/pullrequests`;
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
  const project = encodeURIComponent(remote.project);
  const repository = encodeURIComponent(remote.repository);
  return {
    repo: worktree.repo,
    id: created.pullRequestId,
    title: created.title,
    url: `https://dev.azure.com/${remote.organization}/${project}/_git/${repository}/pullrequest/${created.pullRequestId}`,
  };
}
