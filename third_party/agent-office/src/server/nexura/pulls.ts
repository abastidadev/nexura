// nexura: the office's own workers on a floor whose repo lives on Azure DevOps. Their pull requests
// open through Nexura (gh can't), and Claude is told how the office's gh instructions translate to az.
import { execFileSync } from 'node:child_process';
import { boardCall, isAzureRemote, nexuraUrl } from './tracker.js';

export interface AzureRepo {
  organization: string;
  project: string;
  repository: string;
}

/** Organization, project and repository of an Azure DevOps remote URL (https or ssh, old or new host). */
export function parseAzureRemote(url: string | undefined): AzureRepo | undefined {
  if (!url) return undefined;
  const https = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (https) return { organization: decodeURIComponent(https[1]), project: decodeURIComponent(https[2]), repository: decodeURIComponent(https[3]).replace(/\.git$/i, '') };
  const ssh = /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(url);
  if (ssh) return { organization: decodeURIComponent(ssh[1]), project: decodeURIComponent(ssh[2]), repository: decodeURIComponent(ssh[3]).replace(/\.git$/i, '') };
  const old = /\/\/(?:[^@/]+@)?([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (old) return { organization: old[1], project: decodeURIComponent(old[2]), repository: decodeURIComponent(old[3]).replace(/\.git$/i, '') };
  return undefined;
}

const remotes = new Map<string, string | undefined>();

/** The checkout's origin URL, asked once per folder. */
export function originUrl(dir: string): string | undefined {
  if (!remotes.has(dir)) {
    let url: string | undefined;
    try {
      url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      url = undefined;
    }
    remotes.set(dir, url);
  }
  return remotes.get(dir);
}

/**
 * What Claude is told on an Azure DevOps floor: the office speaks gh, this project needs az. One
 * line, with none of < > | & ^ % or double quotes: on Windows it may go through a claude.cmd shim.
 */
export function azureNote(repo: AzureRepo): string {
  const org = `--org https://dev.azure.com/${repo.organization}`;
  const both = `${org} --project '${repo.project}'`;
  const route = `project='${repo.project}'`;
  const note = [
    `This repository is on Azure DevOps (organization ${repo.organization}, project '${repo.project}', repository '${repo.repository}'), not GitHub, so the gh CLI does not work here.`,
    'Wherever you are told to use gh, use the Azure CLI (az, with the azure-devops extension) instead: issues are work items and pull requests are Azure DevOps pull requests, with the same numbers.',
    `Instead of gh issue view N --comments use az boards work-item show --id N ${org}, and for its comments az devops invoke --area wit --resource comments --route-parameters ${route} workItemId=N ${org} --api-version 7.1-preview.`,
    // az boards query returns nothing with the @project macro: the project goes in by name.
    `Instead of gh issue list use az boards query ${both} --wiql with a WIQL SELECT over [System.TeamProject] = '${repo.project}' (not @project, which az does not fill in).`,
    `Instead of gh pr view N use az repos pr show --id N ${org}, and for its comment threads az devops invoke --area git --resource pullRequestThreads --route-parameters ${route} repositoryId='${repo.repository}' pullRequestId=N ${org}.`,
    'Instead of gh pr diff N run git fetch origin, then git diff origin/TARGET...origin/SOURCE with the branches az repos pr show gives.',
    `Instead of gh pr checkout N use az repos pr checkout --id N ${org}; instead of gh pr checks N use az repos pr policy list --id N ${org}.`,
    `Instead of gh pr create use az repos pr create ${both} --repository '${repo.repository}' --source-branch BRANCH --target-branch BASE --title TITLE --description DESCRIPTION, adding --work-items N to link a work item.`,
    'Where a pull request should close issue #N, link work item N with --work-items N or write AB#N in its description.',
  ].join(' ');
  return note.replace(/[<>|&^%"]/g, '');
}

/** Extra arguments for Claude on this floor: the Azure DevOps note, when its origin is on Azure DevOps. */
export function nexuraClaudeArgs(dir: string): string[] {
  const url = originUrl(dir);
  const repo = isAzureRemote(url) ? parseAzureRemote(url) : undefined;
  return repo ? ['--append-system-prompt', azureNote(repo)] : [];
}

/** The open pull request from `branch` of an Azure DevOps checkout; undefined on any other (ask gh). */
export async function nexuraFindPr(cwd: string, branch: string, base = nexuraUrl()): Promise<{ number: number; url: string } | undefined | 'not-azure'> {
  if (!isAzureRemote(originUrl(cwd))) return 'not-azure';
  const r = await boardCall<{ pull?: { number?: unknown; url?: unknown } | null }>(base, cwd, `/pull-by-branch?branch=${encodeURIComponent(branch)}`);
  return r.pull && typeof r.pull.number === 'number' && typeof r.pull.url === 'string' ? { number: r.pull.number, url: r.pull.url } : undefined;
}

/**
 * Opens a pull request for an already pushed branch of an Azure DevOps checkout, through Nexura.
 * Undefined when the checkout isn't on Azure DevOps (the office's gh does it).
 */
export async function nexuraCreatePr(cwd: string, pr: { branch: string; base?: string; title: string; body: string }, base = nexuraUrl()): Promise<{ number: number; url: string } | undefined> {
  if (!isAzureRemote(originUrl(cwd))) return undefined;
  const target = pr.base ?? defaultBranch(cwd);
  // "Closes #12" / "Fixes #12" in the body links that work item to the PR.
  const issue = Number(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(pr.body)?.[1]) || undefined;
  const r = await boardCall<{ number?: unknown; url?: unknown }>(base, cwd, '/pulls', { branch: pr.branch, base: target, title: pr.title, body: pr.body, issue }, 90_000);
  if (typeof r.number !== 'number' || typeof r.url !== 'string') throw new Error('Nexura did not return the pull request');
  return { number: r.number, url: r.url };
}

/** The remote's default branch (origin/HEAD), else main. */
function defaultBranch(cwd: string): string {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}
