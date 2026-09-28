import type { CreatedTicket, TicketItem, TicketIteration, TicketKind, TicketOptions, TicketSample } from "@nexura/shared";
import { githubRequest } from "./github-client.ts";
import { myLogin } from "./issues.ts";
import { repoApiPath, type GithubRepo } from "./repo-remote.ts";

const PAGE_SIZE = 100;
const MAX_SAMPLES = 18;
const FULL_SAMPLES = 3;
const MAX_SAMPLE_TEXT = 1500;
/** Issue types of an organisation that stand for a story, in order of preference. */
const STORY_TYPES = ["Feature", "Enhancement", "Task"];
/** Labels GitHub creates in every repo, used for the kind when the organisation has no issue types. */
const KIND_LABELS: Record<TicketKind, string> = { story: "enhancement", bug: "bug" };

type Issue = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  labels: (string | { name?: string })[];
  milestone?: { title?: string } | null;
  type?: { name?: string } | null;
  pull_request?: unknown;
  author_association?: string;
};

/** Anyone can open an issue on a public repo: only the team's own are shown to the assistant as its style. */
const TEAM_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const labelsOf = (issue: Issue): string[] =>
  issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
const clip = (text: string): string => (text.length > MAX_SAMPLE_TEXT ? `${text.slice(0, MAX_SAMPLE_TEXT)}…` : text);
const sameRepo = (a: GithubRepo, b: GithubRepo): boolean => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/** Open milestones stand for sprints: the current one is the next to be due (today included). */
export function milestoneIterations(milestones: { number: number; title: string; due_on?: string | null }[], now = new Date()): TicketIteration[] {
  const today = now.toISOString().slice(0, 10);
  const current = milestones
    .filter((milestone) => milestone.due_on && milestone.due_on.slice(0, 10) >= today)
    .sort((a, b) => a.due_on!.localeCompare(b.due_on!))[0];
  return milestones.map((milestone) => ({
    value: String(milestone.number),
    name: milestone.title,
    end: milestone.due_on ?? undefined,
    current: milestone === current,
  }));
}

/**
 * What can be picked for a new issue of the repo: its labels, open milestones (the sprints),
 * assignable users and the organisation's issue types (none on a personal account). Plain REST.
 */
export async function ticketOptionsGithub(remote: GithubRepo): Promise<TicketOptions> {
  const base = repoApiPath(remote);
  const [labels, milestones, assignees, issueTypes, me] = await Promise.all([
    githubRequest<{ name: string }[]>(`${base}/labels?per_page=${PAGE_SIZE}`),
    githubRequest<{ number: number; title: string; due_on?: string | null }[]>(`${base}/milestones?state=open&sort=due_on&direction=asc&per_page=${PAGE_SIZE}`).catch(() => []),
    githubRequest<{ login: string }[]>(`${base}/assignees?per_page=${PAGE_SIZE}`).catch(() => []),
    githubRequest<{ name: string; is_enabled?: boolean }[]>(`orgs/${encodeURIComponent(remote.owner)}/issue-types`).catch(() => []),
    myLogin().catch(() => undefined),
  ]);
  const types = new Set(issueTypes.filter((type) => type.is_enabled !== false).map((type) => type.name));
  return {
    source: "github",
    target: `${remote.owner}/${remote.repo}`,
    types: { story: STORY_TYPES.find((type) => types.has(type)) ?? "", bug: types.has("Bug") ? "Bug" : "" },
    teams: [],
    iterations: milestoneIterations(milestones),
    people: assignees.map((user) => ({ value: user.login, name: user.login })).sort((a, b) => a.name.localeCompare(b.name)),
    me,
    labels: labels.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
  };
}

/** Whether an issue is of `kind`, by its issue type or, without types, by the `bug` label. */
function isKind(issue: Issue, kind: TicketKind, types: TicketOptions["types"]): boolean {
  const bug = types.bug ? issue.type?.name === types.bug : labelsOf(issue).some((label) => label.toLowerCase() === KIND_LABELS.bug);
  return kind === "bug" ? bug : !bug;
}

/** The latest issues of that kind (closed ones included): the team's style. The first few carry their body. */
export async function similarIssues(remote: GithubRepo, kind: TicketKind, types: TicketOptions["types"]): Promise<TicketSample[]> {
  const issues = await githubRequest<Issue[]>(`${repoApiPath(remote)}/issues?state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}`);
  return issues
    .filter((issue) => !issue.pull_request && TEAM_AUTHORS.has(issue.author_association ?? "") && isKind(issue, kind, types))
    .slice(0, MAX_SAMPLES)
    .map((issue, index) => ({
      id: issue.number,
      title: issue.title,
      type: issue.type?.name || "Issue",
      state: issue.state,
      iteration: issue.milestone?.title ?? undefined,
      tags: labelsOf(issue),
      ...(index < FULL_SAMPLES ? { description: clip((issue.body ?? "").trim()) } : {}),
    }));
}

/** An issue reference as written in another issue of `from`: `#12`, or `owner/repo#12` across repos. */
export function issueRef(from: GithubRepo, to: GithubRepo, number: number): string {
  return sameRepo(from, to) ? `#${number}` : `${to.owner}/${to.repo}#${number}`;
}

/** The issue body: GitHub has one field, so a story is its description and criteria, a bug its repro steps. */
export function issueBody(item: TicketItem): string {
  const parts = item.kind === "story" ? [item.description, item.acceptanceCriteria] : [item.reproSteps];
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

/**
 * Creates the issue: labels the repo already has (plus `bug`/`enhancement` when the
 * organisation has no issue types), the chosen milestone and assignee. With `related`, both
 * issues end with a `Related:` line pointing at each other (GitHub has no link type).
 */
export async function createIssue(
  remote: GithubRepo,
  item: TicketItem,
  options: Pick<TicketOptions, "types" | "labels">,
  related?: { remote: GithubRepo; number: number },
): Promise<CreatedTicket> {
  const known = new Map(options.labels.map((label) => [label.toLowerCase(), label]));
  const labels = new Set(item.tags.map((tag) => known.get(tag.toLowerCase())).filter((label): label is string => Boolean(label)));
  const type = options.types[item.kind];
  const kindLabel = known.get(KIND_LABELS[item.kind]);
  if (!type && kindLabel) {
    labels.add(kindLabel);
  }
  const body = [issueBody(item), related ? `Related: ${issueRef(remote, related.remote, related.number)}` : ""].filter(Boolean).join("\n\n");
  const created = await githubRequest<Issue>(`${repoApiPath(remote)}/issues`, {
    method: "POST",
    body: {
      title: item.title.trim(),
      body,
      labels: [...labels],
      ...(item.assignee ? { assignees: [item.assignee] } : {}),
      ...(item.iteration ? { milestone: Number(item.iteration) } : {}),
      ...(type ? { type } : {}),
    },
  });
  if (related) {
    const path = `${repoApiPath(related.remote)}/issues/${related.number}`;
    const other = await githubRequest<Issue>(path);
    const line = `Related: ${issueRef(related.remote, remote, created.number)}`;
    await githubRequest(path, { method: "PATCH", body: { body: [(other.body ?? "").trim(), line].filter(Boolean).join("\n\n") } });
  }
  return { id: created.number, url: created.html_url };
}
