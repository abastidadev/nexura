// nexura: Nexura's flows as workers at the office's desks. Nexura (apps/server/src/office/office-bridge.ts)
// posts a snapshot of its live runs to POST /nexura/workers with a shared token; each run becomes a
// WorkerInfo with `external` set: no terminal, no process, nothing persisted. Clicking one opens the
// run in Nexura (see src/client/nexura/external.ts).
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import type { AgentProvider, ServerMsg, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { BEANBAGS, DESKS } from '../../shared/layout.js';
import { toolAction } from '../../shared/actions.js';
import { parseNexuraScreen, type NexuraScreen } from '../../shared/nexura-screen.js';
import { watchNexuraDesks } from './workers.js';

/** One run as Nexura sends it (OfficeWorker in Nexura). */
export interface NexuraWorker {
  id: string;
  runId: string;
  name: string;
  title: string;
  status: 'starting' | 'working' | 'needs_input' | 'done' | 'exited';
  step?: string;
  provider?: 'claude' | 'codex' | 'custom';
  model?: string;
  activity?: string;
  tool?: { name: string; command?: string };
  repoDirs: string[];
  pr?: { number: number; url: string };
  url: string;
  createdAt: number;
  waitingSince?: number;
  /** What its laptop shows: the run's page in small, or its PR's. */
  screen?: NexuraScreen;
  /** What the run has cost so far (USD). */
  costUsd?: number;
}

/** What the bridge needs from a floor. */
export interface BridgeFloor {
  id: string;
  dir: string;
  workers: { list(): WorkerInfo[] };
}

export interface BridgeDeps {
  floors(): Iterable<BridgeFloor>;
  emit(floor: BridgeFloor, msg: ServerMsg): void;
}

/** Nexura resends every 20 s; after this long without news its workers leave. */
const STALE_MS = 60_000;
const MAX_BODY = 1024 * 1024;
const MAX_WORKERS = 60;
const STATUSES = new Set<WorkerStatus>(['starting', 'working', 'needs_input', 'done', 'exited']);
const PROVIDERS = new Set<AgentProvider>(['claude', 'codex', 'custom']);
const COLORS: Record<string, string> = { claude: '#d97757', codex: '#10a37f', custom: '#8957e5' };
/** Nexura's workers take desks from the back of the room first, leaving the front ones to the office's own. */
const SEATS = [...DESKS].reverse().concat(BEANBAGS);

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const url = str(value, 2048);
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

/** Only what the office can use from one posted worker; undefined when it's not a worker at all. */
export function parseWorker(raw: unknown): NexuraWorker | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 80);
  const runId = str(r.runId, 80);
  const url = httpUrl(r.url);
  const status = r.status as WorkerStatus;
  if (!id?.startsWith('nexura-') || !runId || !url || !STATUSES.has(status)) return undefined;
  const tool = r.tool && typeof r.tool === 'object' ? (r.tool as Record<string, unknown>) : undefined;
  const pr = r.pr && typeof r.pr === 'object' ? (r.pr as Record<string, unknown>) : undefined;
  const prNumber = num(pr?.number);
  const prUrl = httpUrl(pr?.url);
  return {
    id,
    runId,
    name: str(r.name, 40) ?? runId,
    title: str(r.title, 200) ?? '',
    status: status as NexuraWorker['status'],
    step: str(r.step, 60),
    provider: PROVIDERS.has(r.provider as AgentProvider) ? (r.provider as NexuraWorker['provider']) : undefined,
    model: str(r.model, 80),
    activity: str(r.activity, 120),
    tool: tool && str(tool.name, 120) ? { name: str(tool.name, 120)!, command: str(tool.command, 2000) } : undefined,
    repoDirs: Array.isArray(r.repoDirs) ? r.repoDirs.flatMap((d) => str(d, 1024) ?? []).slice(0, 20) : [],
    pr: prNumber !== undefined && prUrl ? { number: prNumber, url: prUrl } : undefined,
    url,
    createdAt: num(r.createdAt) ?? Date.now(),
    waitingSince: num(r.waitingSince),
    screen: parseNexuraScreen(r.screen),
    costUsd: num(r.costUsd),
  };
}

function norm(dir: string): string {
  const p = path.resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** The floor of the run's project: the one whose checkout is (or contains) one of its repos; else the first floor. */
export function floorFor<F extends BridgeFloor>(worker: NexuraWorker, floors: F[]): F | undefined {
  const dirs = worker.repoDirs.map(norm);
  const exact = floors.find((f) => dirs.includes(norm(f.dir)));
  if (exact) return exact;
  const inside = floors.find((f) => dirs.some((d) => d.startsWith(`${norm(f.dir)}/`)));
  return inside ?? floors[0];
}

/** The office's view of one of Nexura's runs. */
export function workerInfo(w: NexuraWorker, deskId: string): WorkerInfo {
  const action = w.status === 'working' && w.tool ? toolAction(w.tool.name, { command: w.tool.command }) : undefined;
  return {
    id: w.id,
    kind: 'agent',
    provider: w.provider,
    model: w.model,
    deskId,
    name: w.name,
    color: COLORS[w.provider ?? ''] ?? '#8d99ae',
    status: w.status,
    // Only a run waiting on an approval or on quota calls for someone; finished ones don't nag.
    acked: w.status !== 'needs_input',
    waitingSince: w.status === 'needs_input' ? w.waitingSince : undefined,
    createdBy: 'Nexura',
    createdAt: w.createdAt,
    title: w.title,
    cols: 80,
    rows: 24,
    viewers: [],
    viewerIds: [],
    activity: w.activity,
    action,
    task: { name: `Nexura${w.step ? ` · ${w.step}` : ''}${w.costUsd ? ` · $${w.costUsd.toFixed(2)}` : ''}`, summary: w.activity ? `${w.title} — ${w.activity}` : w.title },
    pr: w.pr,
    external: { source: 'nexura', runId: w.runId, url: w.url, ...(w.screen ? { screen: w.screen } : {}), ...(w.step ? { step: w.step } : {}), ...(w.costUsd !== undefined ? { costUsd: w.costUsd } : {}) },
  };
}

export class NexuraBridge {
  /** floor id → worker id → what that floor was last told. */
  private byFloor = new Map<string, Map<string, WorkerInfo>>();
  private expiry: NodeJS.Timeout | undefined;

  constructor(
    private readonly token: string | undefined,
    private readonly deps: BridgeDeps,
  ) {}

  get enabled(): boolean {
    return !!this.token;
  }

  /** Nexura's workers on this floor, for whoever walks in. */
  list(floor: { id: string } | undefined): WorkerInfo[] {
    return floor ? [...(this.byFloor.get(floor.id)?.values() ?? [])] : [];
  }

  /** Whether one of Nexura's workers sits at this desk (the office's own can't take it). */
  deskTaken(floorId: string, deskId: string): boolean {
    for (const w of this.byFloor.get(floorId)?.values() ?? []) if (w.deskId === deskId) return true;
    return false;
  }

  /** POST /nexura/workers: `Authorization: Bearer <NEXURA_OFFICE_TOKEN>`, body `{ workers: NexuraWorker[] }`. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    };
    if (!this.token) return reply(404, { error: 'Not found' });
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return reply(401, { error: 'Bad token' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return reply(413, { error: 'Too large' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: 'Bad JSON' });
    }
    const raw = (parsed as { workers?: unknown })?.workers;
    if (!Array.isArray(raw)) return reply(400, { error: 'Expected { workers: [] }' });
    const seated = this.apply(raw.slice(0, MAX_WORKERS).flatMap((w) => parseWorker(w) ?? []));
    reply(200, { ok: true, seated });
  }

  /** Seats a full snapshot: new runs sit down, changed ones update, missing ones go home. Returns how many sit. */
  apply(workers: NexuraWorker[]): number {
    clearTimeout(this.expiry);
    if (workers.length) {
      this.expiry = setTimeout(() => this.apply([]), STALE_MS);
      this.expiry.unref();
    }
    const floors = [...this.deps.floors()];
    for (const floor of floors) watchNexuraDesks(floor.workers, (deskId) => this.deskTaken(floor.id, deskId));

    // Where each one sits now: same floor and desk as before when it's still free, else the next free seat.
    const next = new Map<string, Map<string, WorkerInfo>>(floors.map((f) => [f.id, new Map()]));
    const pending: [BridgeFloor, NexuraWorker][] = [];
    for (const w of workers) {
      const floor = floorFor(w, floors);
      if (!floor) continue;
      const before = this.byFloor.get(floor.id)?.get(w.id);
      const real = new Set(floor.workers.list().map((x) => x.deskId));
      if (before && !real.has(before.deskId)) next.get(floor.id)!.set(w.id, workerInfo(w, before.deskId));
      else pending.push([floor, w]);
    }
    for (const [floor, w] of pending) {
      const taken = new Set([...floor.workers.list().map((x) => x.deskId), ...[...next.get(floor.id)!.values()].map((x) => x.deskId)]);
      const seat = SEATS.find((d) => !taken.has(d.id));
      if (seat) next.get(floor.id)!.set(w.id, workerInfo(w, seat.id));
    }

    // Tell each floor what changed.
    let seated = 0;
    for (const floor of floors) {
      const was = this.byFloor.get(floor.id) ?? new Map<string, WorkerInfo>();
      const now = next.get(floor.id)!;
      seated += now.size;
      for (const [id, old] of was) {
        const cur = now.get(id);
        if (!cur || cur.deskId !== old.deskId) this.deps.emit(floor, { t: 'worker.remove', workerId: id });
      }
      for (const [id, cur] of now) {
        const old = was.get(id);
        // A flow's PR just merged: the floor's gong rings for it, as for the office's own.
        const pr = cur.external?.screen?.pr;
        if (old && pr?.state === 'merged' && old.external?.screen?.pr?.state !== 'merged') this.deps.emit(floor, { t: 'gong', why: 'merged', pr: pr.number, by: 'Nexura' });
        if (!old || old.deskId !== cur.deskId || JSON.stringify(old) !== JSON.stringify(cur)) this.deps.emit(floor, { t: 'worker.update', worker: cur });
      }
    }
    this.byFloor = next;
    return seated;
  }

  stop() {
    clearTimeout(this.expiry);
  }
}
