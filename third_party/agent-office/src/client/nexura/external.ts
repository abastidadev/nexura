// nexura: Nexura's runs sit at desks with no terminal behind them (see server/nexura/bridge.ts).
// Opening one opens the run in Nexura: the page around the office when it's embedded there, else a tab.
import type { WorkerInfo } from '../../shared/protocol';
import { h, toast } from '../ui/dom';
import { approveLabel, openApprove } from './desk';

/** Messages Nexura's Oficina 3D page listens for (apps/web/src/app/features/office-3d). */
export type NexuraPage = 'reviews' | 'shop' | 'achievements' | 'metrics' | 'runs';
export type NexuraMessage = { type: 'nexura:open-run'; runId: string } | { type: 'nexura:new-run'; repoDir?: string; ticketId: string; source: 'azure' | 'github'; project?: string } | { type: 'nexura:open-page'; page: NexuraPage; repo?: string };

/**
 * Sends a message to Nexura when the office is framed by it; false when it isn't. It carries only
 * ids, and Nexura accepts it only from its own office iframe, so any origin may receive it.
 */
export function toNexura(message: NexuraMessage): boolean {
  if (window.parent === window) return false;
  window.parent.postMessage(message, '*');
  return true;
}

/**
 * With the office in its own window: how many Nexura windows are open, and where Nexura is. Asked
 * now and then, so a click can decide at once (a new tab must open while the click still counts).
 */
const nexuraWindows = { count: 0, url: '' };
async function countNexuraWindows() {
  try {
    const r = await fetch('/api/nexura/open');
    if (!r.ok) {
      nexuraWindows.count = 0;
      return;
    }
    const j = (await r.json()) as { windows?: number; url?: string };
    nexuraWindows.count = j.windows ?? 0;
    nexuraWindows.url = j.url ?? '';
  } catch {
    nexuraWindows.count = 0;
  }
}
if (window.parent === window) {
  void countNexuraWindows();
  setInterval(() => void countNexuraWindows(), 10_000);
  window.addEventListener('focus', () => void countNexuraWindows());
}

/**
 * Shows something in the Nexura window you already have open (on your other screen, say), which
 * navigates there without stealing the focus from the office. With no Nexura window, a new tab.
 */
function openInNexura(request: { kind: 'run'; runId: string } | { kind: 'new-run'; ticketId: string; source: 'azure' | 'github'; repoDir?: string } | { kind: 'page'; page: NexuraPage; repo?: string }, fallbackUrl: string) {
  if (nexuraWindows.count > 0) {
    void fetch('/api/nexura/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
      .then((r) => {
        if (r.ok) toast('↗ Abierto en tu ventana de Nexura');
        else throw new Error(`Nexura answered ${r.status}`);
      })
      .catch(() => {
        nexuraWindows.count = 0;
        toast('No se pudo abrir en Nexura. Vuelve a intentarlo.');
        void countNexuraWindows();
      });
    return;
  }
  window.open(fallbackUrl, '_blank', 'noopener');
}

/** Opens a page of Nexura (Revisiones, the shop…): around the office when Nexura frames it, else in its window. */
export function openNexuraPage(page: NexuraPage, repo?: string): void {
  if (toNexura({ type: 'nexura:open-page', page, ...(repo ? { repo } : {}) })) return;
  if (!nexuraWindows.url && !nexuraWindows.count) {
    toast('Abre Nexura (npm run start:all) para ver esto');
    return;
  }
  openInNexura({ kind: 'page', page, ...(repo ? { repo } : {}) }, `${nexuraWindows.url}/${page}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
}

/** Opens a run of Nexura by its id (from the control room's list). */
export function openNexuraRunId(runId: string): void {
  if (!toNexura({ type: 'nexura:open-run', runId })) openInNexura({ kind: 'run', runId }, `${nexuraWindows.url}/runs/${runId}`);
}

/** Opens the Nexura run a worker stands for: around the office when Nexura frames it, else in Nexura's window. */
export function openNexuraRun(w: WorkerInfo): void {
  const ext = w.external;
  if (!ext) return;
  if (!toNexura({ type: 'nexura:open-run', runId: ext.runId })) openInNexura({ kind: 'run', runId: ext.runId }, ext.url);
}

/**
 * A key pressed at a Nexura worker's desk. Its PR opens with O; everything else that would open a
 * terminal opens the run. Sending it home or resuming it is Nexura's business, so those do nothing.
 */
export function nexuraDeskKey(w: WorkerInfo, key: string): void {
  if (key === 'O' && w.pr) {
    window.open(w.pr.url, '_blank', 'noopener');
    return;
  }
  if (key === 'P' && openApprove(w, () => openNexuraRun(w))) return;
  if (key === 'E' || key === 'O' || key === 'C' || key === 'P') openNexuraRun(w);
}

/** What the laptop at a Nexura worker's desk says, since it has no terminal to show. */
export function nexuraScreen(w: WorkerInfo): string {
  return w.activity ? `🔗 Nexura · ${w.activity}` : `🔗 ${w.task?.name ?? 'Nexura'}`;
}

/** Why a Nexura worker can't take an issue card: its work comes from Nexura. */
export function nexuraCardRefusal(w: WorkerInfo): string {
  return w.external ? `${w.name} is a Nexura flow — start a new one from the issue` : '';
}

/** The key hints at a Nexura worker's desk. `key` and `aside` are main.ts's hint pieces. */
export function nexuraHint(
  w: WorkerInfo,
  status: string,
  key: (k: string, label: string) => HTMLElement,
  aside: (text: string) => HTMLElement,
): { k: string; parts: (HTMLElement | string)[] } {
  return {
    k: `nexura${w.id}${w.status}${w.activity ?? ''}${w.pr?.number ?? ''}${approveLabel(w) ?? ''}${w.external?.costUsd ?? ''}`,
    parts: [
      h('span.title', {}, `${w.name} · ${status}`),
      w.activity ? aside(w.activity) : '',
      w.external?.costUsd ? aside(`💸 $${w.external.costUsd.toFixed(2)}`) : '',
      approveLabel(w) ? key('P', approveLabel(w)!) : '',
      key('E', 'Abrir en Nexura'),
      w.pr ? key('O', `PR #${w.pr.number}`) : '',
    ],
  };
}

/** Whether a git remote is on Azure DevOps (same test as server/nexura/tracker.ts). */
function azureRemote(url: string | undefined): boolean {
  return !!url && /(^|[@/.])(dev\.azure\.com|[\w-]+\.visualstudio\.com)[:/]|^[\w-]+@vs-ssh\.visualstudio\.com:/i.test(url);
}

/** `owner/repo` of a GitHub remote, for Nexura to find the issue. */
function githubRepo(url: string | undefined): string | undefined {
  return url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
}

/**
 * "Resolve with Nexura" in an issue's window: it opens Nexura's New flow with the ticket and repo
 * filled in, around the office or in Nexura's own window. Nothing starts until you confirm there.
 */
export function nexuraIssueButton(issue: { number: number }, project: { dir: string; remote?: string } | null): HTMLElement | '' {
  if (!project || !canStartFlows()) return '';
  return h(
    'button.btn',
    { type: 'button', title: 'Open a new Nexura flow for this issue (you pick the profile and model there; nothing runs yet)', onclick: () => startNexuraFlow(issue.number, project) },
    '🚀 Resolve with Nexura',
  );
}

/** Whether there is a Nexura to start a flow in: around the office, or a window of its own. */
export function canStartFlows(): boolean {
  return window.parent !== window || !!nexuraWindows.url;
}

/** Opens Nexura's New flow with an issue of this floor's project filled in. Nothing runs until you confirm there. */
export function startNexuraFlow(issue: number, project: { dir: string; remote?: string }): void {
  const source = azureRemote(project.remote) ? 'azure' : 'github';
  const ticketId = String(issue);
  if (toNexura({ type: 'nexura:new-run', ticketId, source, repoDir: project.dir, project: source === 'github' ? githubRepo(project.remote) : undefined })) return;
  openInNexura({ kind: 'new-run', ticketId, source, repoDir: project.dir }, `${nexuraWindows.url}/new?ticket=${ticketId}&source=${source}`);
}

/** What the office's windows say about GitHub, as it reads on a floor whose boards come from Azure DevOps. */
const AZURE_WORDS: [RegExp, string][] = [
  [/The server runs `gh` in the project directory — make sure it is installed and authenticated \(gh auth login\)\./g, 'The boards come from Azure DevOps through Nexura: start the office with `npm run start:all`, and sign in with `az login` (or give Nexura a PAT).'],
  [/the office's gh account/g, 'the Azure DevOps account Nexura uses'],
  [/\bGitHub issue\b/g, 'Azure DevOps work item'],
  [/\bGitHub\b/g, 'Azure DevOps'],
];

function reword(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (!text.includes('GitHub') && !text.includes('`gh`') && !text.includes('gh account')) return;
    let next = text;
    for (const [from, to] of AZURE_WORDS) next = next.replace(from, to);
    if (next !== text) node.nodeValue = next;
    return;
  }
  if (!(node instanceof Element)) return;
  const title = node.getAttribute('title');
  if (title?.includes('GitHub')) node.setAttribute('title', AZURE_WORDS.reduce((t, [from, to]) => t.replace(from, to), title));
  if (node.matches('.md, textarea, input')) return;
  for (const child of node.childNodes) reword(child);
}

/** Organization and project of an Azure DevOps remote (https, ssh or the old visualstudio.com host). */
export function azureProjectUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const https = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//i.exec(remote);
  if (https) return `https://dev.azure.com/${https[1]}/${https[2]}`;
  const ssh = /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\//i.exec(remote);
  if (ssh) return `https://dev.azure.com/${ssh[1]}/${ssh[2]}`;
  const old = /\/\/(?:[^@/]+@)?([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i.exec(remote);
  return old ? `https://dev.azure.com/${old[1]}/${old[2]}` : undefined;
}

/**
 * In rendered Markdown the office links #12 as a GitHub issue and @someone to github.com. On Azure
 * DevOps, #12 is work item 12 of the project, and a mention is just a name.
 */
function fixAzureLinks(root: Element, project: string) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('.md a.ref')) {
    const n = /#(\d+)$/.exec(a.textContent ?? '')?.[1];
    if (n) a.href = `${project}/_workitems/edit/${n}`;
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>('.md a.mention')) a.replaceWith(a.textContent ?? '');
}

/**
 * On a floor whose repo is on Azure DevOps, the boards' and windows' "GitHub" reads "Azure DevOps".
 * Only inside dialogs, and never in what people wrote (the chat, rendered Markdown, text boxes).
 */
export function watchForgeWords(project: () => { remote?: string } | null) {
  const inDialog = (node: Node) => {
    const el = node instanceof Element ? node : node.parentElement;
    return !!el?.closest('[role="dialog"], .modal') && !el.closest('.md, textarea, input');
  };
  new MutationObserver((records) => {
    const remote = project()?.remote;
    if (!azureRemote(remote)) return;
    const projectUrl = azureProjectUrl(remote);
    for (const r of records) {
      if (projectUrl) for (const node of r.addedNodes) if (node instanceof Element) fixAzureLinks(node.matches('.md') ? node.parentElement ?? node : node, projectUrl);
      if (r.type === 'characterData') {
        if (inDialog(r.target)) reword(r.target);
        continue;
      }
      for (const node of r.addedNodes) {
        if (inDialog(node)) reword(node);
        // A window often arrives inside an overlay that isn't the dialog itself.
        else if (node instanceof Element) node.querySelectorAll('[role="dialog"], .modal').forEach(reword);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
