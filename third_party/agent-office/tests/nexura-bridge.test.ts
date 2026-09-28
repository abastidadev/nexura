import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { DESKS } from '../src/shared/layout.js';
import { floorFor, NexuraBridge, parseWorker, workerInfo, type BridgeFloor, type NexuraWorker } from '../src/server/nexura/bridge.js';

function run(overrides: Partial<NexuraWorker> = {}): NexuraWorker {
  return {
    id: 'nexura-r1',
    runId: 'r1',
    name: '#4521',
    title: 'Login con SSO',
    status: 'working',
    step: 'implement',
    provider: 'claude',
    model: 'opus',
    repoDirs: ['/code/app'],
    url: 'http://localhost:4310/runs/r1',
    createdAt: 1,
    ...overrides,
  };
}

function floor(id: string, dir: string, real: Partial<WorkerInfo>[] = []): BridgeFloor {
  return { id, dir, workers: { list: () => real as WorkerInfo[] } };
}

function bridge(floors: BridgeFloor[], token: string | undefined = 'secret') {
  const sent: [string, ServerMsg][] = [];
  const b = new NexuraBridge(token, { floors: () => floors, emit: (f, msg) => sent.push([f.id, msg]) });
  return { b, sent };
}

test('nexura: a run sits at the back desk of its own project floor and the office can no longer hire there', () => {
  const app = floor('app', '/code/app');
  const other = floor('other', '/code/other');
  const { b, sent } = bridge([other, app]);
  assert.equal(b.apply([run()]), 1);
  const [w] = b.list(app);
  assert.equal(w.deskId, DESKS.at(-1)!.id);
  assert.deepEqual(w.external, { source: 'nexura', runId: 'r1', url: 'http://localhost:4310/runs/r1' });
  assert.deepEqual(b.list(other), []);
  assert.deepEqual(sent, [['app', { t: 'worker.update', worker: w }]]);
  assert.equal(app.workers.nexuraDesk?.(w.deskId), true);
  assert.equal(app.workers.nexuraDesk?.(DESKS[0].id), false);
  b.stop();
});

test('nexura: runs keep their desk, update only when they change, and leave when Nexura stops sending them', () => {
  const app = floor('app', '/code/app', [{ id: 'real', deskId: DESKS.at(-1)!.id }]);
  const { b, sent } = bridge([app]);
  b.apply([run()]);
  const desk = b.list(app)[0].deskId;
  assert.equal(desk, DESKS.at(-2)!.id, 'skips the desk a real worker sits at');
  sent.length = 0;
  b.apply([run()]);
  assert.deepEqual(sent, [], 'nothing changed');
  b.apply([run({ status: 'needs_input', activity: 'esperando aprobación', waitingSince: 5 })]);
  assert.equal(sent.length, 1);
  const waiting = (sent[0][1] as { worker: WorkerInfo }).worker;
  assert.equal(waiting.deskId, desk);
  assert.equal(waiting.acked, false);
  assert.equal(waiting.waitingSince, 5);
  sent.length = 0;
  b.apply([]);
  assert.deepEqual(sent, [['app', { t: 'worker.remove', workerId: 'nexura-r1' }]]);
});

test('nexura: the floor is the checkout holding the repo, else the first floor', () => {
  const floors = [floor('a', '/x/a'), floor('mono', '/code/mono')];
  assert.equal(floorFor(run({ repoDirs: ['/code/mono/packages/api'] }), floors)?.id, 'mono');
  assert.equal(floorFor(run({ repoDirs: ['/elsewhere'] }), floors)?.id, 'a');
  assert.equal(floorFor(run(), []), undefined);
});

test('nexura: a working run acts out its tool, and its task card says which step it is on', () => {
  const testing = workerInfo(run({ tool: { name: 'Bash', command: 'npm test' }, activity: 'Bash npm test' }), 'd1');
  assert.equal(testing.action, 'test');
  assert.deepEqual(testing.task, { name: 'Nexura · implement', summary: 'Login con SSO — Bash npm test' });
  assert.equal(workerInfo(run({ status: 'done', tool: { name: 'Edit' } }), 'd1').action, undefined);
  assert.equal(workerInfo(run({ status: 'done' }), 'd1').acked, true);
});

test('nexura: posted workers are checked field by field', () => {
  assert.equal(parseWorker({ ...run(), id: 'r1' }), undefined, 'ids are namespaced');
  assert.equal(parseWorker({ ...run(), url: 'javascript:alert(1)' }), undefined);
  assert.equal(parseWorker({ ...run(), status: 'offline' }), undefined);
  const parsed = parseWorker({ ...run(), provider: 'opencode', pr: { number: 7, url: 'file:///etc' }, extra: 1 });
  assert.equal(parsed?.provider, undefined);
  assert.equal(parsed?.pr, undefined);
  assert.equal((parsed as unknown as Record<string, unknown>).extra, undefined);
});

async function post(b: NexuraBridge, body: string, auth?: string, method = 'POST') {
  const server = http.createServer((req, res) => void b.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/nexura/workers`, { method, body: method === 'POST' ? body : undefined, headers: auth ? { authorization: auth } : {} });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('nexura: POST /nexura/workers needs the shared token and does nothing without one', async () => {
  const app = floor('app', '/code/app');
  const off = new NexuraBridge(undefined, { floors: () => [app], emit: () => {} });
  assert.equal((await post(off, '{"workers":[]}', 'Bearer ')).status, 404);
  const { b } = bridge([app]);
  assert.equal((await post(b, '{"workers":[]}')).status, 401);
  assert.equal((await post(b, '{"workers":[]}', 'Bearer wrong!')).status, 401);
  assert.equal((await post(b, 'nope', 'Bearer secret')).status, 400);
  assert.equal((await post(b, '', 'Bearer secret', 'GET')).status, 405);
  const ok = await post(b, JSON.stringify({ workers: [run(), { junk: true }] }), 'Bearer secret');
  assert.deepEqual(ok, { status: 200, body: { ok: true, seated: 1 } });
  b.stop();
});
