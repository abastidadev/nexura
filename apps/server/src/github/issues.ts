import type { TicketDetails, WorkItemScope, WorkItemSummary } from "@nexura/shared";
import { GithubError, githubRequest } from "./github-client.ts";
import { repoApiPath, type GithubRepo } from "./repo-remote.ts";

const MAX_COMMENTS = 10;
const PAGE_SIZE = 100;
const MAX_OPEN_ISSUES = 200;

type Issue = {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  updated_at: string;
  comments: number;
  labels: (string | { name?: string })[];
  assignees?: { login: string }[] | null;
  milestone?: { title?: string } | null;
  /** Issue types (organisation feature): Bug, Feature, Task… */
  type?: { name?: string } | null;
  /** Present when the "issue" is a pull request. */
  pull_request?: unknown;
};

type IssueComment = { body?: string | null; created_at: string; user?: { login?: string } | null };

const labelsOf = (issue: Issue): string[] =>
  issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);

const typeOf = (issue: Issue): string => issue.type?.name || "Issue";

let cachedLogin: string | undefined;

/** Login of the signed-in user (cached). */
export async function myLogin(): Promise<string> {
  cachedLogin ??= (await githubRequest<{ login: string }>("user")).login;
  return cachedLogin;
}

/**
 * Reads an issue like getTicket reads a work item: body (already markdown), labels, the
 * latest comments and the sub-issues as tasks. Plain REST, no tokens.
 */
export async function getIssue(remote: GithubRepo, number: number): Promise<TicketDetails> {
  const base = repoApiPath(remote);
  const issue = await githubRequest<Issue>(`${base}/issues/${number}`);
  if (issue.pull_request) {
    throw new GithubError(`#${number} es una pull request, no un issue`, 400);
  }

  let comments: TicketDetails["comments"] = [];
  if (issue.comments > 0) {
    try {
      const lastPage = Math.ceil(issue.comments / PAGE_SIZE);
      const list = await githubRequest<IssueComment[]>(`${base}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${lastPage}`);
      comments = list.slice(-MAX_COMMENTS).map((comment) => ({
        author: comment.user?.login ?? "",
        date: comment.created_at,
        text: (comment.body ?? "").trim(),
      }));
    } catch {
      // Comments are a nice-to-have; the ticket is still usable without them.
    }
  }

  let children: TicketDetails["children"] = [];
  try {
    const subIssues = await githubRequest<Issue[]>(`${base}/issues/${number}/sub_issues?per_page=${PAGE_SIZE}`);
    children = subIssues.map((child) => ({
      id: child.number,
      title: child.title,
      state: child.state,
      type: typeOf(child),
      done: child.state === "closed",
    }));
  } catch {
    // Sub-issues are optional (and missing on older GitHub Enterprise servers).
  }

  return {
    source: "github",
    id: issue.number,
    type: typeOf(issue),
    title: issue.title,
    state: issue.state,
    project: `${remote.owner}/${remote.repo}`,
    url: issue.html_url,
    description: (issue.body ?? "").trim(),
    acceptanceCriteria: "",
    reproSteps: "",
    comments,
    children,
    labels: labelsOf(issue),
  };
}

/** Open issues of the repo for the picker (pull requests left out), most recently updated first. No tokens. */
export async function listOpenIssues(remote: GithubRepo, scope: WorkItemScope): Promise<WorkItemSummary[]> {
  const params = new URLSearchParams({ state: "open", sort: "updated", direction: "desc", per_page: String(PAGE_SIZE) });
  if (scope === "mine") {
    params.set("assignee", await myLogin());
  }
  const issues: Issue[] = [];
  for (let page = 1; issues.length < MAX_OPEN_ISSUES; page++) {
    params.set("page", String(page));
    const batch = await githubRequest<Issue[]>(`${repoApiPath(remote)}/issues?${params}`);
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < PAGE_SIZE) {
      break;
    }
  }
  return issues.slice(0, MAX_OPEN_ISSUES).map((issue) => ({
    id: issue.number,
    type: typeOf(issue),
    title: issue.title,
    state: issue.state,
    project: `${remote.owner}/${remote.repo}`,
    assignedTo: (issue.assignees ?? []).map((assignee) => assignee.login).join(", "),
    iteration: issue.milestone?.title ?? "",
    changedDate: issue.updated_at,
    labels: labelsOf(issue),
  }));
}
