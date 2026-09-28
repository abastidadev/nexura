// nexura: the laptop at a Nexura run's desk. A CLI's laptop shows its live terminal; a Nexura run has
// none, so its laptop shows where opening it takes you: the run's page in small (its steps and what it
// did lately) or, once it has one, its PR's page. It's drawn as a terminal screen, so the laptop paints
// it with the same code as a CLI's (world/laptop.ts, paintScreen).
import { FLAG_BOLD, RGB_FLAG, type Run, type WorkerInfo } from '../../shared/protocol';
import type { NexuraScreen, NexuraStepStatus } from '../../shared/nexura-screen';
import type { ScreenState } from '../world/laptop';

const COLS = 64;
const ROWS = 22;

const rgb = (hex: string) => RGB_FLAG | parseInt(hex.slice(1), 16);
const C = {
  text: rgb('#e6e6f0'),
  dim: rgb('#8b90a8'),
  white: rgb('#ffffff'),
  accent: rgb('#a99cff'),
  accentBg: rgb('#6f5ee0'),
  ok: rgb('#7cf29a'),
  warn: rgb('#ffd166'),
  err: rgb('#ff5c7a'),
  info: rgb('#6cb6ff'),
  github: rgb('#2d333b'),
  azure: rgb('#0078d4'),
  merged: rgb('#8957e5'),
  openBg: rgb('#238636'),
  closedBg: rgb('#da3633'),
};

type Seg = [text: string, fg?: number, bg?: number, bold?: boolean];

/** One row of the screen; a background on its last piece runs to the right edge, like a title bar. */
function row(...segs: Seg[]): Run[] {
  const runs: Run[] = [];
  let width = 0;
  for (const [text, fg = C.text, bg = -1, bold = false] of segs) {
    const room = COLS - width;
    if (room <= 0) break;
    const t = [...text].slice(0, room).join('');
    runs.push([t, fg, bg, bold ? FLAG_BOLD : 0]);
    width += [...t].length;
  }
  const last = segs.at(-1);
  if (last && last[2] !== undefined && last[2] >= 0 && width < COLS) runs.push([' '.repeat(COLS - width), C.text, last[2], 0]);
  return runs;
}

/** Words of `text` over as many rows as it takes, `max` at most (the last one ends in …). */
function wrap(text: string, width: number, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line ? line.length + 1 : 0) + word.length > width) {
      if (line) out.push(line);
      line = word.slice(0, width);
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length > max) {
    out.length = max;
    out[max - 1] = `${out[max - 1].slice(0, width - 1)}…`;
  }
  return out;
}

const STEP_MARK: Record<NexuraStepStatus, [string, number]> = {
  succeeded: ['✔', C.ok],
  running: ['●', C.warn],
  failed: ['✖', C.err],
  skipped: ['»', C.dim],
  pending: ['○', C.dim],
};

/** The pipeline as chips, over as many rows as it needs. */
function pipeline(steps: NexuraScreen['steps']): Run[][] {
  const rows: Run[][] = [];
  let segs: Seg[] = [[' ']];
  let width = 1;
  for (const s of steps) {
    const [mark, color] = STEP_MARK[s.status];
    const chip = `${mark} ${s.name}  `;
    if (width + chip.length > COLS && segs.length > 1) {
      rows.push(row(...segs));
      segs = [[' ']];
      width = 1;
    }
    segs.push([`${mark} `, color, -1, true], [`${s.name}  `, s.status === 'running' ? C.white : s.status === 'pending' ? C.dim : C.text, -1, s.status === 'running']);
    width += chip.length;
  }
  if (segs.length > 1) rows.push(row(...segs));
  return rows;
}

function status(w: WorkerInfo): Seg {
  if (w.status === 'working') return ['● trabajando', C.warn, -1, true];
  if (w.status === 'needs_input') return ['⏸ te espera', C.warn, -1, true];
  if (w.status === 'done') return ['✔ terminado', C.ok, -1, true];
  if (w.status === 'exited') return ['✖ parado', C.err, -1, true];
  return ['… en cola', C.dim, -1, true];
}

function logRows(s: NexuraScreen, w: WorkerInfo, n: number): Run[][] {
  const lines = s.log.slice(-n);
  if (!lines.length) return [row(['  (sin actividad todavía)', C.dim])];
  return lines.map((text, i) => {
    const latest = i === lines.length - 1 && w.status === 'working';
    return row([latest ? ' › ' : '   ', latest ? C.warn : C.dim, -1, latest], [text.slice(0, COLS - 3), latest ? C.white : C.text]);
  });
}

function runPage(w: WorkerInfo, s: NexuraScreen): Run[][] {
  const lines: Run[][] = [];
  const who = w.name.startsWith('#') ? `Flujo ${w.name}` : 'Flujo';
  lines.push(row([' ◆ NEXURA ', C.white, C.accentBg, true], [` ${who}`, C.white, C.accentBg]));
  lines.push([]);
  for (const t of wrap(w.title ?? '', COLS - 2, 2)) lines.push(row([` ${t}`, C.white, -1, true]));
  lines.push(row([` ${[s.repos.join(', '), s.agent].filter(Boolean).join(' · ')}`, C.dim], ['   '], status(w)));
  lines.push(row([` ${'─'.repeat(COLS - 2)}`, C.dim]));
  lines.push(...pipeline(s.steps));
  lines.push([]);
  lines.push(row([' Actividad', C.accent, -1, true]));
  lines.push(...logRows(s, w, 7));
  if (w.activity && w.status !== 'working') lines.push([], row([` ${w.activity}`, w.status === 'exited' ? C.err : C.warn]));
  return lines;
}

function prPage(w: WorkerInfo, s: NexuraScreen, pr: NonNullable<NexuraScreen['pr']>): Run[][] {
  const lines: Run[][] = [];
  const azure = pr.provider === 'azure';
  const bar = azure ? C.azure : C.github;
  lines.push(row([azure ? ' ⎇ Azure DevOps ' : ' ⎇ GitHub ', C.white, bar, true], [` Pull request · ${s.repos.join(', ')}`, C.white, bar]));
  lines.push([]);
  const title = wrap(pr.title || w.title || '', COLS - 10, 2);
  title.forEach((t, i) => lines.push(row([` ${t}`, C.white, -1, true], ...(i === title.length - 1 ? ([[`  #${pr.number}`, C.dim]] as Seg[]) : []))));
  const badge: Seg = pr.state === 'merged' ? [' ⎇ Merged ', C.white, C.merged, true] : pr.state === 'closed' ? [' ✖ Closed ', C.white, C.closedBg, true] : [' ● Open ', C.white, C.openBg, true];
  const branch = pr.source ? `${pr.source}${pr.target ? ` → ${pr.target}` : ''}` : '';
  lines.push(row([' '], badge, [`  ${[pr.author, branch].filter(Boolean).join(' · ')}`, C.dim]));
  lines.push([]);
  lines.push(row([' Conversation', C.white, -1, true], ['   Commits   Files changed', C.dim]));
  lines.push(row([` ${'─'.repeat(12)}`, C.accent], [`${'─'.repeat(COLS - 14)}`, C.dim]));
  if (pr.review) {
    const r = pr.review;
    lines.push(row([' ◆ Nexura ', C.accent, -1, true], [`revisó: ${r.comments} comentario${r.comments === 1 ? '' : 's'}`, C.text], ...(r.important ? ([[` · ${r.important} importante${r.important === 1 ? '' : 's'}`, C.warn, -1, true]] as Seg[]) : []), [r.published ? ' · publicada' : ' · sin publicar', r.published ? C.ok : C.dim]));
  } else {
    lines.push(row([' ◆ Nexura ', C.accent, -1, true], ['abrió esta PR desde el flujo', C.text], ...(pr.threads ? ([[` · ${pr.threads} hilo${pr.threads === 1 ? '' : 's'} abierto${pr.threads === 1 ? '' : 's'}`, C.info, -1, true]] as Seg[]) : [])));
  }
  lines.push([]);
  lines.push(...pipeline(s.steps));
  lines.push([]);
  lines.push(...logRows(s, w, 4));
  return lines;
}

/** djb2 of the screen, so the laptop repaints only when it changes. */
function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

const cache = new Map<string, { key: string; state: ScreenState }>();

/** What the laptop at a Nexura run's desk shows; undefined for the office's own workers. */
export function nexuraLaptopScreen(w: WorkerInfo | undefined): ScreenState | undefined {
  const s = w?.external?.screen;
  if (!w || !s) return undefined;
  const key = JSON.stringify([w.status, w.title, w.name, w.activity, s]);
  const hit = cache.get(w.id);
  if (hit?.key === key) return hit.state;
  const lines = (s.pr ? prPage(w, s, s.pr) : runPage(w, s)).slice(0, ROWS);
  while (lines.length < ROWS) lines.push([]);
  const state: ScreenState = { cols: COLS, rows: ROWS, lines, cursor: [0, 0], version: hash(key) };
  cache.set(w.id, { key, state });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return state;
}
