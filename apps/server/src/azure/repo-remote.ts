import { git } from "../workspace/git.ts";

export type AzureRepo = { organization: string; project: string; repository: string };

/**
 * Parses the Azure DevOps remote forms:
 *   https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>
 *   git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
 */
export function parseAzureRemote(url: string): AzureRepo | undefined {
  const decode = (value: string): string => decodeURIComponent(value.replace(/\.git$/, ""));
  let match = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/.exec(url);
  if (match) {
    return { organization: decode(match[1]!), project: decode(match[2]!), repository: decode(match[3]!) };
  }
  match = /([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/.exec(url);
  if (match) {
    return { organization: decode(match[1]!), project: decode(match[2]!), repository: decode(match[3]!) };
  }
  match = /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(url);
  if (match) {
    return { organization: decode(match[1]!), project: decode(match[2]!), repository: decode(match[3]!) };
  }
  return undefined;
}

export async function azureRepoOf(repoPath: string): Promise<AzureRepo | undefined> {
  try {
    return parseAzureRemote(await git(repoPath, ["remote", "get-url", "origin"]));
  } catch {
    return undefined;
  }
}
