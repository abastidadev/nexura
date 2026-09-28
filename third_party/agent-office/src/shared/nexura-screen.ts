// nexura: what the laptop at a Nexura run's desk shows, the way a CLI's shows its terminal: the run's
// page in small, or the page of the PR it opened or reviews (Nexura's OfficeScreen, apps/server/src/office).

export type NexuraStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface NexuraScreen {
  steps: { name: string; status: NexuraStepStatus }[];
  log: string[];
  repos: string[];
  agent?: string;
  pr?: {
    number: number;
    title: string;
    provider: 'github' | 'azure';
    source?: string;
    target?: string;
    author?: string;
    state: 'open' | 'merged' | 'closed';
    review?: { comments: number; important: number; published: boolean };
    threads?: number;
  };
}

const STEP_STATUSES = new Set<NexuraStepStatus>(['pending', 'running', 'succeeded', 'failed', 'skipped']);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

/** Only what the laptop can paint from what Nexura sent; undefined when there is nothing usable. */
export function parseNexuraScreen(raw: unknown): NexuraScreen | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const steps = (Array.isArray(r.steps) ? r.steps : []).slice(0, 20).flatMap((s) => {
    const step = obj(s);
    const name = str(step?.name, 40);
    return name && STEP_STATUSES.has(step?.status as NexuraStepStatus) ? [{ name, status: step!.status as NexuraStepStatus }] : [];
  });
  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.slice(-n).flatMap((x) => str(x, max) ?? []) : []);
  const p = obj(r.pr);
  const prNumber = num(p?.number);
  const review = obj(p?.review);
  const pr: NexuraScreen['pr'] =
    p && prNumber !== undefined
      ? {
          number: prNumber,
          title: str(p.title, 200) ?? '',
          provider: p.provider === 'azure' ? 'azure' : 'github',
          source: str(p.source, 120),
          target: str(p.target, 120),
          author: str(p.author, 80),
          state: p.state === 'merged' || p.state === 'closed' ? p.state : 'open',
          review: review ? { comments: num(review.comments) ?? 0, important: num(review.important) ?? 0, published: review.published === true } : undefined,
          threads: num(p.threads),
        }
      : undefined;
  return { steps, log: list(r.log, 8, 160), repos: list(r.repos, 10, 80), agent: str(r.agent, 60), pr };
}
