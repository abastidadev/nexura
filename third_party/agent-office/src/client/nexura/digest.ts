// nexura: what the office shows of Nexura beyond the workers at their desks, asked for in one go
// (Nexura's /api/office/digest, through the office's server): the flows running for the control room,
// the merged PRs for the Hall of Fame, today's numbers, PRs to review and the quota left.
import { nexura } from './wallet';

export interface DigestFlow {
  runId: string;
  name: string;
  title: string;
  status: string;
  agent: string;
  steps: { step: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' }[];
  current?: string;
  waiting?: 'step' | 'pr' | 'replies';
  costUsd: number;
}
export interface Digest {
  active: DigestFlow[];
  merged: { runId: string; name: string; title: string; url?: string; mergedAt: string; agents: string[] }[];
  today: { flowsDone: number; prsOpened: number; prsMerged: number; reviews: number; costUsd: number; trophies: string[]; coins: number };
  toReview: { repo: string; id: number; title: string; author: string; url: string; reviewed: boolean }[];
  quota: { label: string; percent: number; resetsAt?: number }[];
}

let digest: Digest | null = null;
let started = false;
const listeners = new Set<(next: Digest, before: Digest | null) => void>();

export function currentDigest(): Digest | null {
  return digest;
}

/** Runs `fn` with every new digest (and the one before it, to spot what changed). */
export function onDigest(fn: (next: Digest, before: Digest | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function flowOf(runId: string): DigestFlow | undefined {
  return digest?.active.find((f) => f.runId === runId);
}

export async function loadDigest(): Promise<void> {
  try {
    const next = await nexura<Digest>('digest');
    const before = digest;
    digest = next;
    listeners.forEach((fn) => fn(next, before));
  } catch {
    // Nexura isn't there: the screens keep what they showed last.
  }
}

/** Every 8 s while the page is in front. */
export function startDigest(): void {
  if (started) return;
  started = true;
  void loadDigest();
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadDigest();
  }, 8000);
}
