// nexura: the Issues and PR boards of a floor whose repo lives on Azure DevOps, through Nexura
// (apps/server/src/office/office-api.ts), which holds the `az login` session and speaks ADO's REST.
// It stands in for the GitHub class: same public members, so the rest of the office can't tell.
import { readFile } from 'node:fs/promises';
import type { GhCheck, GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhReviewComment, GhState } from '../../shared/protocol.js';
import { GitHub } from '../github.js';

/** Every public member of the GitHub class: what a floor's boards need from whoever fills them. */
export type Tracker = { [K in keyof GitHub]: GitHub[K] };

const REFRESH_MS = 90_000;
const LABELS_MS = 60_000;

/** Whether a git remote URL is on Azure DevOps (dev.azure.com or the older visualstudio.com). */
export function isAzureRemote(url: string | undefined): boolean {
  return !!url && /(^|[@/.])(dev\.azure\.com|[\w-]+\.visualstudio\.com)[:/]|^[\w-]+@vs-ssh\.visualstudio\.com:/i.test(url);
}

/** Where Nexura listens: NEXURA_URL, which `npm run start:all` sets. */
export function nexuraUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.NEXURA_URL?.trim().replace(/\/+$/, '');
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

// ---- Checking what Nexura sends, field by field ---------------------------------------------------
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function label(v: unknown): GhLabel {
  const l = obj(v);
  return { name: str(l.name), color: /^#[0-9a-f]{3,8}$/i.test(str(l.color)) ? str(l.color) : '#888888', description: l.description ? str(l.description) : undefined };
}

function comment(v: unknown): GhComment {
  const c = obj(v);
  return { id: str(c.id), author: str(c.author), body: str(c.body), createdAt: str(c.createdAt), url: c.url ? str(c.url) : undefined, state: c.state ? str(c.state) : undefined };
}

export function toIssue(v: unknown): GhIssue {
  const i = obj(v);
  return {
    number: int(i.number),
    title: str(i.title),
    state: i.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    url: str(i.url),
    author: str(i.author),
    labels: list(i.labels).map(label),
    assignees: list(i.assignees).map(str),
    createdAt: str(i.createdAt),
    updatedAt: str(i.updatedAt),
    body: str(i.body),
    comments: int(i.comments),
  };
}

export function toPull(v: unknown): GhPull {
  const p = obj(v);
  const checks = p.checks === 'pass' || p.checks === 'fail' || p.checks === 'pending' ? p.checks : 'none';
  return {
    number: int(p.number),
    title: str(p.title),
    state: p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN',
    isDraft: p.isDraft === true,
    url: str(p.url),
    author: str(p.author),
    labels: list(p.labels).map(label),
    reviewDecision: str(p.reviewDecision),
    headRefName: str(p.headRefName),
    baseRefName: str(p.baseRefName),
    createdAt: str(p.createdAt),
    updatedAt: str(p.updatedAt),
    additions: int(p.additions),
    deletions: int(p.deletions),
    checks,
    body: str(p.body),
    closes: list(p.closes).map(int).filter((n) => n > 0),
  };
}

function repoInfoOf(v: unknown): GhRepoInfo {
  const r = obj(v);
  const methods = list(r.methods).filter((m): m is GhMergeMethod => m === 'squash' || m === 'merge' || m === 'rebase');
  return { nameWithOwner: str(r.nameWithOwner), methods: methods.length ? methods : ['squash', 'merge', 'rebase'] };
}

function reviewComment(v: unknown): GhReviewComment {
  const c = obj(v);
  return {
    id: int(c.id),
    replyTo: c.replyTo == null ? undefined : int(c.replyTo),
    author: str(c.author),
    body: str(c.body),
    createdAt: str(c.createdAt),
    url: str(c.url),
    path: str(c.path),
    line: c.line == null ? null : int(c.line),
    side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
  };
}

function check(v: unknown): GhCheck {
  const c = obj(v);
  const state = c.state === 'pass' || c.state === 'fail' || c.state === 'skip' ? c.state : 'pending';
  return { name: str(c.name), state, url: c.url ? str(c.url) : undefined };
}

export function toPullDetail(v: unknown): GhPullDetail {
  const p = obj(v);
  return {
    number: int(p.number),
    body: str(p.body),
    state: str(p.state),
    isDraft: p.isDraft === true,
    reviewDecision: str(p.reviewDecision),
    headRefName: str(p.headRefName),
    baseRefName: str(p.baseRefName),
    mergeable: str(p.mergeable) || 'UNKNOWN',
    mergeStateStatus: str(p.mergeStateStatus) || 'UNKNOWN',
    commits: int(p.commits),
    comments: list(p.comments).map(comment),
    reviews: list(p.reviews).map(comment),
    reviewComments: list(p.reviewComments).map(reviewComment),
    checks: list(p.checks).map(check),
    repo: repoInfoOf(p.repo),
    viewer: str(p.viewer),
  };
}

export function toIssueDetail(v: unknown): GhIssueDetail {
  const i = obj(v);
  return { number: int(i.number), state: str(i.state), body: str(i.body), comments: list(i.comments).map(comment), viewer: str(i.viewer) };
}

/** GET (no body) or POST to Nexura's /api/office/board…, about the checkout in `dir`. */
export async function boardCall<T>(base: string | undefined, dir: string, path: string, body?: unknown, timeout = 60_000, fetcher: typeof fetch = fetch): Promise<T> {
  if (!base) throw new Error('Azure DevOps boards need Nexura: start the office with `npm run start:all`');
  const url = new URL(`${base}/api/office/board${path}`);
  url.searchParams.set('dir', dir);
  let res: Response;
  try {
    res = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`Nexura isn't answering at ${base} (${(err as Error).message})`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Nexura answered ${res.status}`);
  return data as T;
}

/** A floor's boards on Azure DevOps: work items on the Issues board, pull requests on the PR board. */
export class NexuraTracker implements Tracker {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private repo?: Promise<GhRepoInfo>;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };

  constructor(
    private dir: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    private base: string | undefined = nexuraUrl(),
    private fetcher: typeof fetch = fetch,
  ) {}

  call<T>(path: string, body?: unknown, timeout = 60_000): Promise<T> {
    return boardCall<T>(this.base, this.dir, path, body, timeout, this.fetcher);
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  repoInfo(): Promise<GhRepoInfo> {
    this.repo ??= this.call<{ repo?: unknown }>('').then((r) => repoInfoOf(r.repo));
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  viewer(): Promise<string> {
    this.login ??= this.call<{ name?: unknown }>('/viewer').then((r) => str(r.name));
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  async pullDetail(n: number): Promise<GhPullDetail> {
    return toPullDetail(await this.call(`/pulls/${n}`));
  }

  async pullDiff(n: number): Promise<string> {
    return str((await this.call<{ diff?: unknown }>(`/pulls/${n}/diff`, undefined, 120_000)).diff);
  }

  async issueDetail(n: number): Promise<GhIssueDetail> {
    return toIssueDetail(await this.call(`/issues/${n}`));
  }

  async comment(kind: 'issue' | 'pull', n: number, body: string): Promise<{ comment?: GhComment; error?: string }> {
    try {
      const r = await this.call<{ comment?: unknown }>(`/${kind === 'issue' ? 'issues' : 'pulls'}/${n}/comment`, { body });
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { comment: comment(r.comment) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async review(n: number, file: string): Promise<string> {
    const body = await readFile(file, 'utf8');
    const r = await this.call<{ url?: unknown }>(`/pulls/${n}/review`, { body });
    void this.refreshPulls();
    return str(r.url);
  }

  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean): Promise<string | undefined> {
    try {
      await this.call(`/pulls/${n}/merge`, { method, deleteBranch, auto }, 90_000);
    } catch (err) {
      return (err as Error).message;
    }
    // Azure DevOps completes a PR a few seconds later: look again then, so it shows merged (and the gong rings).
    void this.refreshPulls().then(() => setTimeout(() => void this.refreshPulls(), 5000));
    return undefined;
  }

  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined> {
    try {
      await this.call(`/${kind === 'issue' ? 'issues' : 'pulls'}/${n}/close`, opts);
    } catch (err) {
      return (err as Error).message;
    }
    void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    return undefined;
  }

  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const labels = this.call<unknown[]>('/labels').then((r) => list(r).map(label));
      this.labelList = { at: Date.now(), list: labels };
      labels.catch(() => this.labelList?.list === labels && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    try {
      const r = await this.call<{ labels?: unknown }>(`/${kind === 'issue' ? 'issues' : 'pulls'}/${n}/labels`, { add, remove });
      const labels = list(r.labels).map(label);
      // The board shows them at once, before the next look at Azure DevOps.
      if (kind === 'issue') {
        this.issues = { ...this.issues, items: this.issues.items.map((i) => (i.number === n ? { ...i, labels } : i)) };
        this.onIssues(this.issues);
      } else {
        this.pulls = { ...this.pulls, items: this.pulls.items.map((p) => (p.number === n ? { ...p, labels } : p)) };
        this.onPulls(this.pulls);
      }
      return { labels };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async claim(issue: number): Promise<string | undefined> {
    try {
      await this.call(`/issues/${issue}/claim`, {});
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues();
    return undefined;
  }

  private async refreshIssues() {
    if (this.issues.loading) return;
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    try {
      const items = list(await this.call<unknown[]>('/issues')).map(toIssue);
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    try {
      const items = list(await this.call<unknown[]>('/pulls')).map(toPull);
      this.pulls = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}

/** The class that fills a floor's boards: Nexura's for Azure DevOps remotes, the office's GitHub otherwise. */
export function trackerClass(remote: string | undefined): typeof GitHub {
  return isAzureRemote(remote) ? (NexuraTracker as unknown as typeof GitHub) : GitHub;
}
