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

/**
 * The URL as configured first, then as git resolves it (`url.<base>.insteadOf` applied): an
 * alias like `gh:owner/repo` only parses once resolved, while a mirror or a local copy
 * that stands in for the real remote (the /try-fake sandbox) only parses as configured.
 */
export async function repoRemoteOf(repoPath: string): Promise<RepoRemote | undefined> {
  for (const args of [["config", "--get", "remote.origin.url"], ["remote", "get-url", "origin"]]) {
    try {
      const remote = parseRemote(await git(repoPath, args));
      if (remote) {
        return remote;
      }
    } catch {
      // No origin: try the next form, then give up.
    }
  }
  return undefined;
}
