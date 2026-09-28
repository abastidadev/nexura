import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { nexuraLaptopScreen } from '../src/client/nexura/screen.js';

function worker(screen: NonNullable<NonNullable<WorkerInfo['external']>['screen']>): WorkerInfo {
  return {
    id: 'nexura-run-42',
    name: '#42',
    title: 'Arreglar el login con SSO',
    status: 'working',
    external: { source: 'nexura', runId: 'run-42', url: 'http://localhost:4310/runs/run-42', screen },
  } as WorkerInfo;
}

function textOf(workerInfo: WorkerInfo): string {
  return nexuraLaptopScreen(workerInfo)!.lines.flatMap((line) => line.map((run) => run[0])).join('\n');
}

test('nexura: the laptop paints a live run with its steps and recent activity', () => {
  const text = textOf(worker({ steps: [{ name: 'implement', status: 'running' }], log: ['Edit login.ts'], repos: ['app'], agent: 'claude · opus' }));
  assert.match(text, /NEXURA/);
  assert.match(text, /implement/);
  assert.match(text, /Edit login\.ts/);
});

test('nexura: the laptop paints the reviewed PR when a run has one', () => {
  const text = textOf(worker({
    steps: [], log: [], repos: ['app'],
    pr: { number: 9, title: 'Login con SSO', provider: 'github', state: 'open', review: { comments: 3, important: 1, published: true } },
  }));
  assert.match(text, /GitHub/);
  assert.match(text, /Login con SSO/);
  assert.match(text, /#9/);
  assert.match(text, /3 comentarios/);
});
