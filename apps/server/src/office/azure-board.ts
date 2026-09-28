import { createHash } from "node:crypto";
import { azureGitEnv, azureRequest } from "../azure/azure-client.ts";
import { htmlToText } from "../azure/html-to-text.ts";
import { PR_DESCRIPTION_MAX, pullRequestUrl } from "../azure/pull-requests.ts";
import type { AzureRepo } from "../azure/repo-remote.ts";
import { markdownToHtml } from "../azure/text-to-html.ts";
import { git, gitRaw, stripAttribution } from "../workspace/git.ts";

/*
 * The 3D office's Issues and PR boards for a repo on Azure DevOps. The office speaks GitHub
 * (third_party/agent-office/src/server/github.ts); these are the same operations on work items and
 * pull requests, in shapes that mirror its Gh* types. Its side (src/server/nexura/nexura-tracker.ts)
 * checks them field by field. Plain REST: no tokens.
 */

export type BoardLabel = { name: string; color: string; description?: string };

export type BoardIssue = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
  author: string;
  labels: BoardLabel[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
  comments: number;
};

export type BoardPull = {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
  author: string;
  labels: BoardLabel[];
  reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  checks: "pass" | "fail" | "pending" | "none";
  body: string;
  closes: number[];
};

export type BoardComment = { id: string; author: string; body: string; createdAt: string; url?: string; state?: string };

export type BoardReviewComment = {
  id: number;
  replyTo?: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
};

export type BoardCheck = { name: string; state: "pass" | "fail" | "pending" | "skip"; url?: string };

export type MergeMethod = "squash" | "merge" | "rebase";

export type BoardRepoInfo = { nameWithOwner: string; methods: MergeMethod[] };

export type BoardIssueDetail = { number: number; state: string; body: string; comments: BoardComment[]; viewer: string };

export type BoardPullDetail = {
  number: number;
  body: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  commits: number;
  comments: BoardComment[];
  reviews: BoardComment[];
  reviewComments: BoardReviewComment[];
  checks: BoardCheck[];
  repo: BoardRepoInfo;
  viewer: string;
};

type WorkItem = { id: number; fields: Record<string, unknown>; rev?: number };
type Identity = { displayName?: string; uniqueName?: string; id?: string };
type ApiPull = {
  pullRequestId: number;
  title: string;
  description?: string;
  status: "active" | "completed" | "abandoned";
  isDraft?: boolean;
  createdBy?: Identity;
  creationDate: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  labels?: { name: string; active?: boolean }[];
  reviewers?: (Identity & { vote?: number })[];
  lastMergeSourceCommit?: { commitId?: string };
  repository?: { project?: { id?: string } };
};
type ApiThread = {
  id: number;
  isDeleted?: boolean;
  status?: string;
  publishedDate?: string;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
  comments: { id: number; parentCommentId?: number; content?: string; commentType?: string; isDeleted?: boolean; author?: Identity; publishedDate?: string }[];
};

const CLOSED_STATES = new Set(["Closed", "Done", "Removed", "Resolved", "Completed"]);
const NON_TICKET_TYPES = ["Task", "Test Case", "Test Plan", "Test Suite", "Shared Steps", "Shared Parameter"];
const OPEN_MAX = 300;
const CLOSED_MAX = 40;
const BODY_MAX = 4000;
const IDS_PER_CALL = 200;
const COMMENTS_API = "7.1-preview.4";
const TAGS_API = "7.1-preview.1";
const LABELS_API = "7.1-preview.1";
const LABEL_COLORS = ["#d73a4a", "#0075ca", "#a2eeef", "#7057ff", "#008672", "#e4e669", "#d876e3", "#fbca04", "#0e8a16", "#5319e7", "#b60205", "#1d76db"];
const MERGE_STRATEGY: Record<MergeMethod, string> = { squash: "squash", merge: "noFastForward", rebase: "rebase" };

const field = (item: WorkItem, name: string): string => String(item.fields[name] ?? "");
const identity = (value: unknown): string => (value && typeof value === "object" ? ((value as Identity).displayName ?? "") : String(value ?? ""));
const branch = (ref: string): string => ref.replace(/^refs\/heads\//, "");
const clip = (text: string): string => text.slice(0, BODY_MAX);
const wiqlList = (values: Iterable<string>): string => [...values].map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
const projectPath = (remote: AzureRepo): string => encodeURIComponent(remote.project);
const pullsPath = (remote: AzureRepo): string => `${projectPath(remote)}/_apis/git/repositories/${encodeURIComponent(remote.repository)}/pullrequests`;

/** A tag's color: always the same one for the same name. */
export function labelColor(name: string): string {
  return LABEL_COLORS[createHash("sha1").update(name.toLowerCase()).digest()[0]! % LABEL_COLORS.length]!;
}

function tagsOf(raw: string): BoardLabel[] {
  return raw
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((name) => ({ name, color: labelColor(name) }));
}

function workItemUrl(remote: AzureRepo, id: number): string {
  return `https://dev.azure.com/${remote.organization}/${projectPath(remote)}/_workitems/edit/${id}`;
}

/** Who `az login` is signed in as: the name the boards show, and the account to assign items to. */
export async function viewer(remote: AzureRepo): Promise<{ name: string; account: string; id: string }> {
  const data = await azureRequest<{ authenticatedUser?: { id?: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } } }>(
    remote.organization,
    "_apis/connectionData",
    { apiVersion: "7.1-preview.1" },
  );
  const user = data.authenticatedUser ?? {};
  return { name: user.providerDisplayName ?? "", account: user.properties?.Account?.$value ?? user.providerDisplayName ?? "", id: user.id ?? "" };
}

async function workItems(remote: AzureRepo, ids: number[], fields: string[]): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  for (let start = 0; start < ids.length; start += IDS_PER_CALL) {
    const chunk = ids.slice(start, start + IDS_PER_CALL);
    const { value } = await azureRequest<{ value: WorkItem[] }>(remote.organization, `_apis/wit/workitems?ids=${chunk.join(",")}&fields=${fields.join(",")}&errorPolicy=omit`);
    items.push(...value.filter(Boolean));
  }
  return items;
}

async function wiql(remote: AzureRepo, query: string, top: number): Promise<number[]> {
  const { workItems: found } = await azureRequest<{ workItems: { id: number }[] }>(remote.organization, `${projectPath(remote)}/_apis/wit/wiql?$top=${top}`, {
    method: "POST",
    body: { query },
  });
  return found.slice(0, top).map((item) => item.id);
}

/** The project's open work items, and the ones closed most recently: the Issues board. */
export async function listIssues(remote: AzureRepo): Promise<BoardIssue[]> {
  const types = `[System.WorkItemType] NOT IN (${wiqlList(NON_TICKET_TYPES)})`;
  const where = `[System.TeamProject] = @project AND ${types}`;
  const [open, closed] = await Promise.all([
    wiql(remote, `SELECT [System.Id] FROM WorkItems WHERE ${where} AND [System.State] NOT IN (${wiqlList(CLOSED_STATES)}) ORDER BY [System.ChangedDate] DESC`, OPEN_MAX),
    wiql(remote, `SELECT [System.Id] FROM WorkItems WHERE ${where} AND [System.State] IN (${wiqlList(CLOSED_STATES)}) ORDER BY [System.ChangedDate] DESC`, CLOSED_MAX),
  ]);
  const ids = [...open, ...closed];
  const fields = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.CreatedBy",
    "System.CreatedDate",
    "System.ChangedDate",
    "System.Tags",
    "System.Description",
    "Microsoft.VSTS.TCM.ReproSteps",
    "System.CommentCount",
  ];
  const byId = new Map((await workItems(remote, ids, fields)).map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    if (!item) {
      return [];
    }
    const assignee = identity(item.fields["System.AssignedTo"]);
    const type = field(item, "System.WorkItemType");
    return [
      {
        number: id,
        title: field(item, "System.Title"),
        state: CLOSED_STATES.has(field(item, "System.State")) ? ("CLOSED" as const) : ("OPEN" as const),
        url: workItemUrl(remote, id),
        author: identity(item.fields["System.CreatedBy"]),
        labels: [...(type ? [{ name: type, color: labelColor(type), description: "Tipo de work item" }] : []), ...tagsOf(field(item, "System.Tags"))],
        assignees: assignee ? [assignee] : [],
        createdAt: field(item, "System.CreatedDate"),
        updatedAt: field(item, "System.ChangedDate"),
        // A bug usually has only repro steps.
        body: clip(htmlToText(field(item, "System.Description") || field(item, "Microsoft.VSTS.TCM.ReproSteps"))),
        comments: Number(item.fields["System.CommentCount"] ?? 0) || 0,
      },
    ];
  });
}

function reviewDecision(pr: ApiPull): BoardPull["reviewDecision"] {
  const votes = (pr.reviewers ?? []).map((reviewer) => reviewer.vote ?? 0);
  if (votes.some((vote) => vote < 0)) {
    return "CHANGES_REQUESTED";
  }
  if (votes.some((vote) => vote > 0)) {
    return "APPROVED";
  }
  return votes.length ? "REVIEW_REQUIRED" : "";
}

function pullOf(remote: AzureRepo, pr: ApiPull): BoardPull {
  return {
    number: pr.pullRequestId,
    title: pr.title,
    state: pr.status === "completed" ? "MERGED" : pr.status === "abandoned" ? "CLOSED" : "OPEN",
    isDraft: Boolean(pr.isDraft),
    url: pullRequestUrl(remote, pr.pullRequestId),
    author: pr.createdBy?.displayName ?? "",
    labels: (pr.labels ?? []).filter((label) => label.active !== false).map((label) => ({ name: label.name, color: labelColor(label.name) })),
    reviewDecision: reviewDecision(pr),
    headRefName: branch(pr.sourceRefName),
    baseRefName: branch(pr.targetRefName),
    createdAt: pr.creationDate,
    updatedAt: pr.closedDate ?? pr.creationDate,
    // Azure DevOps gives no line counts or check rollup in its lists.
    additions: 0,
    deletions: 0,
    checks: "none",
    body: clip(pr.description ?? ""),
    // Linked work items: `AB#123` or `#123` in the description (the links themselves need a call per PR).
    closes: [...new Set([...(pr.description ?? "").matchAll(/(?:AB)?#(\d+)\b/g)].map((match) => Number(match[1])))].filter((n) => n > 0),
  };
}

/** Active PRs, and the latest completed (merged) and abandoned ones: the PR board. */
export async function listPulls(remote: AzureRepo, repoPath?: string): Promise<BoardPull[]> {
  const list = (status: string, top: number) =>
    azureRequest<{ value: ApiPull[] }>(remote.organization, `${pullsPath(remote)}?searchCriteria.status=${status}&$top=${top}`).then(({ value }) => value);
  const [active, completed, abandoned] = await Promise.all([list("active", 150), list("completed", 30), list("abandoned", 40)]);
  const pulls = [...active, ...completed, ...abandoned].map((pr) => pullOf(remote, pr));
  if (repoPath) {
    await lineCounts(repoPath, pulls.filter((pr) => pr.state === "OPEN"));
  }
  return pulls;
}

/** "3 files changed, 12 insertions(+), 4 deletions(-)" → its counts. */
export function shortstat(text: string): { additions: number; deletions: number } {
  return { additions: Number(/(\d+) insertion/.exec(text)?.[1] ?? 0), deletions: Number(/(\d+) deletion/.exec(text)?.[1] ?? 0) };
}

/**
 * Azure DevOps lists PRs without line counts; the local checkout has them. One fetch, then a
 * shortstat per open PR. Best effort: without the branches (or offline) they stay at 0.
 */
async function lineCounts(repoPath: string, pulls: BoardPull[]): Promise<void> {
  if (!pulls.length) {
    return;
  }
  await git(repoPath, ["fetch", "--quiet", "--prune", "origin"], azureGitEnv()).catch(() => undefined);
  await Promise.all(
    pulls.map(async (pr) => {
      const out = await git(repoPath, ["diff", "--shortstat", `origin/${pr.baseRefName}...origin/${pr.headRefName}`]).catch(() => "");
      Object.assign(pr, shortstat(out));
    }),
  );
}

export async function issueDetail(remote: AzureRepo, id: number): Promise<BoardIssueDetail> {
  const [item, comments, me] = await Promise.all([
    azureRequest<WorkItem>(remote.organization, `_apis/wit/workitems/${id}`),
    azureRequest<{ comments: { id: number; text?: string; createdBy?: Identity; createdDate?: string }[] }>(
      remote.organization,
      `${projectPath(remote)}/_apis/wit/workItems/${id}/comments?$top=100&order=asc`,
      { apiVersion: COMMENTS_API },
    ).catch(() => ({ comments: [] })),
    viewer(remote).catch(() => ({ name: "" })),
  ]);
  const description = htmlToText(field(item, "System.Description"));
  const criteria = htmlToText(field(item, "Microsoft.VSTS.Common.AcceptanceCriteria"));
  const repro = htmlToText(field(item, "Microsoft.VSTS.TCM.ReproSteps"));
  const body = [description, criteria && `**Criterios de aceptación**\n\n${criteria}`, repro && `**Pasos para reproducir**\n\n${repro}`].filter(Boolean).join("\n\n");
  return {
    number: id,
    state: CLOSED_STATES.has(field(item, "System.State")) ? "CLOSED" : "OPEN",
    body,
    comments: comments.comments.map((comment) => ({
      id: String(comment.id),
      author: comment.createdBy?.displayName ?? "",
      body: htmlToText(comment.text),
      createdAt: comment.createdDate ?? "",
      url: `${workItemUrl(remote, id)}#${comment.id}`,
    })),
    viewer: me.name,
  };
}

const VOTE_STATE: Record<string, string> = { "10": "APPROVED", "5": "APPROVED", "-5": "CHANGES_REQUESTED", "-10": "CHANGES_REQUESTED" };
const POLICY_STATE: Record<string, BoardCheck["state"]> = { approved: "pass", rejected: "fail", broken: "fail", running: "pending", queued: "pending", notApplicable: "skip" };

/** A PR's description, conversation, line comments, votes, policies and whether it can merge. */
export async function pullDetail(remote: AzureRepo, n: number): Promise<BoardPullDetail> {
  const base = `${pullsPath(remote)}/${n}`;
  const [pr, threads, commits, me] = await Promise.all([
    azureRequest<ApiPull>(remote.organization, base),
    azureRequest<{ value: ApiThread[] }>(remote.organization, `${base}/threads`),
    azureRequest<{ value: unknown[]; count?: number }>(remote.organization, `${base}/commits?$top=250`).catch(() => ({ value: [] as unknown[], count: 0 })),
    viewer(remote).catch(() => ({ name: "" })),
  ]);
  const projectId = pr.repository?.project?.id;
  const policies = projectId
    ? await azureRequest<{ value: { status?: string; configuration?: { type?: { displayName?: string }; settings?: { displayName?: string } } }[] }>(
        remote.organization,
        `${projectPath(remote)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${n}`)}`,
        { apiVersion: "7.1-preview.1" },
      ).catch(() => ({ value: [] }))
    : { value: [] };
  const url = pullRequestUrl(remote, n);
  const human = (thread: ApiThread) => !thread.isDeleted && thread.comments.some((comment) => !comment.isDeleted && comment.commentType !== "system" && comment.content?.trim());
  const comments: BoardComment[] = [];
  const reviewComments: BoardReviewComment[] = [];
  for (const thread of threads.value.filter(human)) {
    const path = thread.threadContext?.filePath?.replace(/^\//, "");
    for (const comment of thread.comments.filter((c) => !c.isDeleted && c.commentType !== "system" && c.content?.trim())) {
      if (path) {
        const line = thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line ?? null;
        reviewComments.push({
          id: thread.id * 1000 + comment.id,
          replyTo: comment.parentCommentId ? thread.id * 1000 + comment.parentCommentId : undefined,
          author: comment.author?.displayName ?? "",
          body: comment.content!,
          createdAt: comment.publishedDate ?? thread.publishedDate ?? "",
          url: `${url}?discussionId=${thread.id}`,
          path,
          line,
          side: thread.threadContext?.rightFileStart ? "RIGHT" : "LEFT",
        });
      } else {
        comments.push({ id: `${thread.id}.${comment.id}`, author: comment.author?.displayName ?? "", body: comment.content!, createdAt: comment.publishedDate ?? "", url: `${url}?discussionId=${thread.id}` });
      }
    }
  }
  const board = pullOf(remote, pr);
  const mergeable = pr.mergeStatus === "succeeded" ? "MERGEABLE" : pr.mergeStatus === "conflicts" ? "CONFLICTING" : "UNKNOWN";
  const checks = policies.value.map((policy) => ({
    name: policy.configuration?.settings?.displayName ?? policy.configuration?.type?.displayName ?? "Directiva",
    state: POLICY_STATE[policy.status ?? ""] ?? "pending",
    url,
  }));
  const blocked = checks.some((check) => check.state === "fail" || check.state === "pending");
  return {
    number: n,
    body: pr.description ?? "",
    state: board.state,
    isDraft: board.isDraft,
    reviewDecision: board.reviewDecision,
    headRefName: board.headRefName,
    baseRefName: board.baseRefName,
    mergeable,
    mergeStateStatus: mergeable === "CONFLICTING" ? "DIRTY" : blocked ? "BLOCKED" : mergeable === "MERGEABLE" ? "CLEAN" : "UNKNOWN",
    commits: commits.count ?? commits.value.length,
    comments,
    reviews: (pr.reviewers ?? [])
      .filter((reviewer) => VOTE_STATE[String(reviewer.vote ?? 0)])
      .map((reviewer) => ({ id: reviewer.id ?? reviewer.displayName ?? "", author: reviewer.displayName ?? "", body: "", createdAt: "", state: VOTE_STATE[String(reviewer.vote)] })),
    reviewComments,
    checks,
    repo: repoInfo(remote),
    viewer: me.name,
  };
}

export function repoInfo(remote: AzureRepo): BoardRepoInfo {
  return { nameWithOwner: `${remote.project}/${remote.repository}`, methods: ["squash", "merge", "rebase"] };
}

/** Comments on a work item, or opens a general thread on a PR, as the `az login` user. */
export async function comment(remote: AzureRepo, kind: "issue" | "pull", n: number, body: string): Promise<BoardComment> {
  if (kind === "issue") {
    const saved = await azureRequest<{ id: number; createdBy?: Identity; createdDate?: string }>(
      remote.organization,
      `${projectPath(remote)}/_apis/wit/workItems/${n}/comments`,
      { method: "POST", body: { text: markdownToHtml(body) }, apiVersion: COMMENTS_API },
    );
    return { id: String(saved.id), author: saved.createdBy?.displayName ?? "", body, createdAt: saved.createdDate ?? new Date().toISOString(), url: `${workItemUrl(remote, n)}#${saved.id}` };
  }
  const thread = await azureRequest<ApiThread>(remote.organization, `${pullsPath(remote)}/${n}/threads`, {
    method: "POST",
    body: { comments: [{ parentCommentId: 0, content: body, commentType: "text" }], status: "active" },
  });
  const first = thread.comments[0];
  return { id: `${thread.id}.${first?.id ?? 1}`, author: first?.author?.displayName ?? "", body, createdAt: first?.publishedDate ?? new Date().toISOString(), url: `${pullRequestUrl(remote, n)}?discussionId=${thread.id}` };
}

/** A review from the meeting room: a general, closed-for-discussion thread with its text. */
export async function review(remote: AzureRepo, n: number, body: string): Promise<string> {
  const thread = await azureRequest<ApiThread>(remote.organization, `${pullsPath(remote)}/${n}/threads`, {
    method: "POST",
    body: { comments: [{ parentCommentId: 0, content: body, commentType: "text" }], status: "closed" },
  });
  return `${pullRequestUrl(remote, n)}?discussionId=${thread.id}`;
}

/** The state a work item type ends in: its "Completed" category (Closed, Done…) or, for "not planned", "Removed". */
async function finalState(remote: AzureRepo, type: string, reason: "completed" | "not planned"): Promise<string> {
  const { value } = await azureRequest<{ value: { name: string; category: string }[] }>(
    remote.organization,
    `${projectPath(remote)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`,
    { apiVersion: "7.1-preview.1" },
  );
  const wanted = reason === "not planned" ? ["Removed", "Completed"] : ["Completed"];
  for (const category of wanted) {
    const state = value.find((candidate) => candidate.category === category);
    if (state) {
      return state.name;
    }
  }
  throw new Error(`El tipo ${type} no tiene un estado final`);
}

async function patchWorkItem(remote: AzureRepo, id: number, operations: { op: string; path: string; value?: unknown }[]): Promise<WorkItem> {
  return azureRequest<WorkItem>(remote.organization, `_apis/wit/workitems/${id}`, { method: "PATCH", body: operations, contentType: "application/json-patch+json" });
}

/** Closes a work item (to its final state) or abandons a PR, optionally saying why first. */
export async function close(remote: AzureRepo, kind: "issue" | "pull", n: number, options: { comment?: string; reason?: "completed" | "not planned"; deleteBranch?: boolean }): Promise<void> {
  if (options.comment?.trim()) {
    await comment(remote, kind, n, options.comment);
  }
  if (kind === "issue") {
    const item = await azureRequest<WorkItem>(remote.organization, `_apis/wit/workitems/${n}?fields=System.WorkItemType`);
    const state = await finalState(remote, field(item, "System.WorkItemType"), options.reason ?? "completed");
    await patchWorkItem(remote, n, [{ op: "add", path: "/fields/System.State", value: state }]);
    return;
  }
  await azureRequest(remote.organization, `${pullsPath(remote)}/${n}`, { method: "PATCH", body: { status: "abandoned" } });
}

/** Completes a PR with the chosen strategy, or sets it to auto-complete once its policies pass. */
export async function merge(remote: AzureRepo, n: number, method: MergeMethod, deleteBranch: boolean, auto: boolean): Promise<void> {
  const pr = await azureRequest<ApiPull>(remote.organization, `${pullsPath(remote)}/${n}`);
  const completionOptions = { mergeStrategy: MERGE_STRATEGY[method], deleteSourceBranch: deleteBranch };
  if (auto) {
    const me = await viewer(remote);
    await azureRequest(remote.organization, `${pullsPath(remote)}/${n}`, { method: "PATCH", body: { autoCompleteSetBy: { id: me.id }, completionOptions } });
    return;
  }
  await azureRequest(remote.organization, `${pullsPath(remote)}/${n}`, {
    method: "PATCH",
    body: { status: "completed", lastMergeSourceCommit: pr.lastMergeSourceCommit, completionOptions },
  });
}

/** Tags of a work item or labels of a PR: adds and removes, returns what it has now. */
export async function setLabels(remote: AzureRepo, kind: "issue" | "pull", n: number, add: string[], remove: string[]): Promise<BoardLabel[]> {
  if (kind === "issue") {
    const item = await azureRequest<WorkItem>(remote.organization, `_apis/wit/workitems/${n}?fields=System.Tags,System.WorkItemType`);
    const type = field(item, "System.WorkItemType");
    const gone = new Set(remove.map((tag) => tag.toLowerCase()));
    // The work item type shows as a label on the board, but it isn't a tag.
    const tags = [...tagsOf(field(item, "System.Tags")).map((tag) => tag.name), ...add.filter((tag) => tag !== type)].filter(
      (tag, index, all) => !gone.has(tag.toLowerCase()) && all.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index,
    );
    // "add" merges into the tags already there; only "replace" takes some off.
    const op = field(item, "System.Tags") ? "replace" : "add";
    const saved = await patchWorkItem(remote, n, [{ op, path: "/fields/System.Tags", value: tags.join("; ") }]);
    return [...(type ? [{ name: type, color: labelColor(type), description: "Tipo de work item" }] : []), ...tagsOf(field(saved, "System.Tags"))];
  }
  const labels = `${pullsPath(remote)}/${n}/labels`;
  for (const name of add) {
    await azureRequest(remote.organization, labels, { method: "POST", body: { name }, apiVersion: LABELS_API });
  }
  for (const name of remove) {
    await azureRequest(remote.organization, `${labels}/${encodeURIComponent(name)}`, { method: "DELETE", apiVersion: LABELS_API }).catch((error: Error) => {
      if (!/404|not found/i.test(error.message)) {
        throw error;
      }
    });
  }
  const { value } = await azureRequest<{ value: { name: string; active?: boolean }[] }>(remote.organization, labels, { apiVersion: LABELS_API });
  return value.filter((label) => label.active !== false).map((label) => ({ name: label.name, color: labelColor(label.name) }));
}

/** The tags used in the project, for the label picker. */
export async function repoLabels(remote: AzureRepo): Promise<BoardLabel[]> {
  const { value } = await azureRequest<{ value: { name: string }[] }>(remote.organization, `${projectPath(remote)}/_apis/wit/tags`, { apiVersion: TAGS_API });
  return value.map((tag) => ({ name: tag.name, color: labelColor(tag.name) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Assigns the work item to the `az login` user, which moves it to In progress on the board. */
export async function claim(remote: AzureRepo, id: number): Promise<void> {
  const me = await viewer(remote);
  await patchWorkItem(remote, id, [{ op: "add", path: "/fields/System.AssignedTo", value: me.account }]);
}

/** Opens a PR from a branch the office already pushed; links the work item it came from, if any. */
export async function createPull(remote: AzureRepo, pull: { branch: string; base: string; title: string; body: string; issue?: number }): Promise<{ number: number; url: string }> {
  const created = await azureRequest<{ pullRequestId: number }>(remote.organization, pullsPath(remote), {
    method: "POST",
    body: {
      sourceRefName: `refs/heads/${pull.branch}`,
      targetRefName: `refs/heads/${pull.base}`,
      title: pull.title,
      description: stripAttribution(pull.body).slice(0, PR_DESCRIPTION_MAX),
      workItemRefs: pull.issue ? [{ id: String(pull.issue) }] : [],
    },
  });
  return { number: created.pullRequestId, url: pullRequestUrl(remote, created.pullRequestId) };
}

/** The active PR from this branch, if there is one. */
export async function findPull(remote: AzureRepo, branchName: string): Promise<{ number: number; url: string } | undefined> {
  const { value } = await azureRequest<{ value: ApiPull[] }>(
    remote.organization,
    `${pullsPath(remote)}?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branchName}`)}&$top=1`,
  );
  const pr = value[0];
  return pr ? { number: pr.pullRequestId, url: pullRequestUrl(remote, pr.pullRequestId) } : undefined;
}

/** The PR's unified diff, as `git diff` prints it: Azure DevOps has none over REST, the local checkout does. */
export async function pullDiff(remote: AzureRepo, repoPath: string, n: number): Promise<string> {
  const pr = await azureRequest<ApiPull>(remote.organization, `${pullsPath(remote)}/${n}`);
  const source = branch(pr.sourceRefName);
  const target = branch(pr.targetRefName);
  await git(repoPath, ["fetch", "--quiet", "origin", source, target], azureGitEnv());
  return gitRaw(repoPath, ["diff", "--no-color", "--no-ext-diff", `origin/${target}...origin/${source}`]);
}
