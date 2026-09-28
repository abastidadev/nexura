// nexura: the repos Nexura works on, offered in the elevator as `nexura/<name>`. Picking one makes
// its local checkout a floor where it is (no `gh repo clone`), which is how Azure DevOps projects,
// that gh can't clone, get a floor.
import type { RepoChoice } from '../../shared/protocol.js';
import { nexuraUrl } from './tracker.js';

export const NEXURA_OWNER = 'nexura';

export interface NexuraRepo {
  name: string;
  path: string;
  provider: 'azure' | 'github' | null;
}

const PROVIDER: Record<string, string> = { azure: 'Azure DevOps', github: 'GitHub' };

/** A Nexura repo name as the elevator's owner/name wants it. */
export function repoSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'repo';
}

/** What Nexura says its repos are; none when it isn't there (the office runs on its own). */
export async function nexuraRepos(base = nexuraUrl(), fetcher: typeof fetch = fetch): Promise<NexuraRepo[]> {
  if (!base) return [];
  try {
    const res = await fetcher(`${base}/api/office/repos`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((r: { name?: unknown; path?: unknown; provider?: unknown }) =>
      typeof r?.name === 'string' && typeof r.path === 'string' ? [{ name: r.name, path: r.path, provider: r.provider === 'azure' || r.provider === 'github' ? r.provider : null }] : [],
    );
  } catch {
    return [];
  }
}

/** The elevator's list: Nexura's repos first, then the ones gh can clone (whose failure alone isn't fatal). */
export async function withNexuraRepos(gh: Promise<RepoChoice[]>, nexura: Promise<NexuraRepo[]> = nexuraRepos()): Promise<RepoChoice[]> {
  const [fromGh, fromNexura] = await Promise.allSettled([gh, nexura]);
  const ours: RepoChoice[] = (fromNexura.status === 'fulfilled' ? fromNexura.value : []).map((r) => ({
    name: `${NEXURA_OWNER}/${repoSlug(r.name)}`,
    description: `${r.provider ? PROVIDER[r.provider] : 'Local'} · ${r.path} — from Nexura, opened where it is`,
    private: true,
  }));
  if (fromGh.status === 'rejected') {
    if (!ours.length) throw fromGh.reason;
    return ours;
  }
  return [...ours, ...fromGh.value.filter((r) => !r.name.toLowerCase().startsWith(`${NEXURA_OWNER}/`))];
}

/** `nexura/<name>` from the elevator: the checkout to open as a floor, if Nexura has that repo. */
export async function nexuraCheckout(input: string, repos: () => Promise<NexuraRepo[]> = () => nexuraRepos()): Promise<{ name: string; dir: string } | undefined> {
  const m = /^nexura\/(.+)$/i.exec(input.trim());
  if (!m) return undefined;
  const repo = (await repos()).find((r) => repoSlug(r.name).toLowerCase() === m[1].toLowerCase());
  return repo ? { name: repo.name, dir: repo.path } : undefined;
}
