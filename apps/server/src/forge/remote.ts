import type { TicketSource } from "@nexura/shared";
import { parseAzureRemote, type AzureRepo } from "../azure/repo-remote.ts";
import { parseGithubRemote, type GithubRepo } from "../github/repo-remote.ts";
import { git } from "../workspace/git.ts";

/** Where a repo's origin lives: that is where its PRs are opened and, by default, where its tickets come from. */
export type RepoRemote = ({ provider: "azure" } & AzureRepo) | ({ provider: "github" } & GithubRepo);

export const PROVIDER_LABEL: Record<TicketSource, string> = { azure: "Azure DevOps", github: "GitHub" };

export function parseRemote(url: string): RepoRemote | undefined {
  const azure = parseAzureRemote(url);
  if (azure) {
    return { provider: "azure", ...azure };
  }
  const github = parseGithubRemote(url);
  return github ? { provider: "github", ...github } : undefined;
}

export async function repoRemoteOf(repoPath: string): Promise<RepoRemote | undefined> {
  try {
    return parseRemote(await git(repoPath, ["remote", "get-url", "origin"]));
  } catch {
    return undefined;
  }
}
