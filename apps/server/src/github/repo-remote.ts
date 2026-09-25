export type GithubRepo = { owner: string; repo: string };

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parses the github.com remote forms:
 *   https://[user@]github.com/<owner>/<repo>[.git]
 *   git@github.com:<owner>/<repo>[.git]
 *   ssh://git@github.com/<owner>/<repo>[.git]
 */
export function parseGithubRemote(url: string): GithubRepo | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** `owner/repo` as typed by the user (e.g. NEXURA_GITHUB_REPO). */
export function parseOwnerRepo(value: string | undefined): GithubRepo | undefined {
  const trimmed = value?.trim() ?? "";
  if (!OWNER_REPO.test(trimmed)) {
    return undefined;
  }
  const [owner, repo] = trimmed.split("/");
  return { owner: owner!, repo: repo! };
}

/** REST path prefix of the repo: `repos/<owner>/<repo>`. */
export function repoApiPath(remote: GithubRepo): string {
  return `repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`;
}
