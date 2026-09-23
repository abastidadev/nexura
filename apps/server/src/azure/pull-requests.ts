import type { CreatedPr, PrDraft, Worktree } from "@nexura/shared";
import { git } from "../workspace/git.ts";
import { azureRequest } from "./azure-client.ts";
import { azureRepoOf } from "./repo-remote.ts";

/** Azure DevOps rejects longer descriptions; the create-pr skill keeps them under this. */
export const PR_DESCRIPTION_MAX = 4000;

type ImplementSummary = { summary: string; filesChanged: string[] };

/**
 * Deterministic PR draft (no tokens): title from the lead commit, description as prose +
 * bullets from what implement reported, following the create-pr skill. The work item is
 * linked on creation, never written in the body. The user reviews and edits it before
 * anything is pushed.
 */
export async function buildPrDraft(
  worktree: Worktree,
  target: string,
  implementSummaries: ImplementSummary[],
  workItemId: number | undefined,
): Promise<PrDraft> {
  const subjects = (await git(worktree.path, ["log", "--format=%s", `${worktree.baseRef}..HEAD`])).split(/\r?\n/).filter(Boolean);
  const lead = subjects.at(-1) ?? worktree.branch;
  const summaries = implementSummaries.map((item) => item.summary.trim()).filter(Boolean);
  const files = [...new Set(implementSummaries.flatMap((item) => item.filesChanged))];
  const bullets = (summaries.length > 1 ? summaries.slice(1) : subjects.slice(0, -1).reverse()).map((line) => `- ${line}`);
  const description = [
    summaries[0] ?? lead,
    bullets.join("\n"),
    files.length ? `Ficheros: ${files.map((file) => `\`${file}\``).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PR_DESCRIPTION_MAX);
  return { repo: worktree.repo, branch: worktree.branch, target, title: lead, description, workItemId, isDraft: false };
}

type CreatedResponse = { pullRequestId: number; title: string };

/** Pushes the branch and opens the PR, linking the work item on creation. */
export async function pushAndCreatePr(worktree: Worktree, draft: PrDraft): Promise<CreatedPr> {
  const remote = await azureRepoOf(worktree.repoPath);
  if (!remote) {
    throw new Error(`${worktree.repo}: el remote origin no es de Azure DevOps`);
  }
  await git(worktree.path, ["push", "-u", "origin", worktree.branch]);
  const project = encodeURIComponent(remote.project);
  const repository = encodeURIComponent(remote.repository);
  const created = await azureRequest<CreatedResponse>(
    remote.organization,
    `${project}/_apis/git/repositories/${repository}/pullrequests`,
    {
      method: "POST",
      body: {
        sourceRefName: `refs/heads/${worktree.branch}`,
        targetRefName: `refs/heads/${draft.target}`,
        title: draft.title,
        description: draft.description.slice(0, PR_DESCRIPTION_MAX),
        isDraft: draft.isDraft,
        workItemRefs: draft.workItemId ? [{ id: String(draft.workItemId) }] : [],
      },
    },
  );
  return {
    repo: worktree.repo,
    id: created.pullRequestId,
    title: created.title,
    url: `https://dev.azure.com/${remote.organization}/${project}/_git/${repository}/pullrequest/${created.pullRequestId}`,
  };
}
