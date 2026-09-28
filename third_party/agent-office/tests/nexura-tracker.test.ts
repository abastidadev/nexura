import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { GhIssue, GhPull, GhState } from '../src/shared/protocol.js';
import { GitHub } from '../src/server/github.js';
import { isAzureRemote, nexuraUrl, NexuraTracker, toIssue, toPull, trackerClass } from '../src/server/nexura/tracker.js';

test('nexura: Azure DevOps remotes get their boards from Nexura, the rest from GitHub', () => {
  for (const url of ['https://dev.azure.com/acme/Shop/_git/web', 'https://acme@dev.azure.com/acme/Shop/_git/web', 'git@ssh.dev.azure.com:v3/acme/Shop/web', 'https://acme.visualstudio.com/Shop/_git/web', 'acme@vs-ssh.visualstudio.com:v3/acme/Shop/web']) {
    assert.equal(isAzureRemote(url), true, url);
    assert.equal(trackerClass(url), NexuraTracker as unknown as typeof GitHub);
  }
  for (const url of ['https://github.com/o/r.git', 'git@github.com:o/r.git', undefined, '']) {
    assert.equal(isAzureRemote(url), false, String(url));
    assert.equal(trackerClass(url), GitHub);
  }
  assert.equal(nexuraUrl({ NEXURA_URL: 'http://localhost:4310/' }), 'http://localhost:4310');
  assert.equal(nexuraUrl({ NEXURA_URL: 'file:///x' }), undefined);
});

test('nexura: what Nexura sends is checked into the office shapes', () => {
  assert.deepEqual(toIssue({ number: 7.9, title: 'SSO', state: 'Active', labels: [{ name: 'ux', color: 'red' }], assignees: ['Ana', 3], comments: '2', extra: 1 }), {
    number: 7,
    title: 'SSO',
    state: 'OPEN',
    url: '',
    author: '',
    labels: [{ name: 'ux', color: '#888888', description: undefined }],
    assignees: ['Ana', '3'],
    createdAt: '',
    updatedAt: '',
    body: '',
    comments: 0,
  });
  const pull = toPull({ number: 5, state: 'MERGED', checks: 'weird', closes: [7, -1, 'x'] });
  assert.equal(pull.state, 'MERGED');
  assert.equal(pull.checks, 'none');
  assert.deepEqual(pull.closes, [7]);
});

type Seen = { method: string; path: string; dir: string | null; body: unknown };

async function fakeNexura(answer: (seen: Seen) => [number, unknown]) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const s = { method: req.method ?? 'GET', path: url.pathname, dir: url.searchParams.get('dir'), body: raw ? JSON.parse(raw) : undefined };
    seen.push(s);
    const [status, body] = answer(s);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test('nexura: the boards fill from Nexura, and actions go to it for this floor', async () => {
  const nexura = await fakeNexura(({ method, path: p }) => {
    if (p === '/api/office/board/issues') return [200, [{ number: 7, title: 'SSO', state: 'OPEN', labels: [] }]];
    if (p === '/api/office/board/pulls') return [200, [{ number: 5, title: 'PR', state: 'OPEN' }]];
    if (p === '/api/office/board/issues/7/labels' && method === 'POST') return [200, { labels: [{ name: 'ux', color: '#0075ca' }] }];
    if (p === '/api/office/board/pulls/5/merge') return [400, { error: 'Las directivas no se cumplen' }];
    if (p === '/api/office/board/pulls/5/review') return [200, { url: 'https://dev.azure.com/x?discussionId=3' }];
    return [404, { error: 'no' }];
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'nexura-tracker-'));
  try {
    const issues: GhState<GhIssue>[] = [];
    const pulls: GhState<GhPull>[] = [];
    const t = new NexuraTracker('C:\\code\\shop', (s) => issues.push(s), (s) => pulls.push(s), nexura.base);
    await t.refresh();
    assert.equal(t.issues.items[0].title, 'SSO');
    assert.equal(t.pulls.items[0].number, 5);
    assert.equal(issues[0].loading, true, 'shows it loading first');
    assert.equal(nexura.seen[0].dir, 'C:\\code\\shop', 'every call says which checkout');

    assert.deepEqual(await t.setLabels('issue', 7, ['ux'], []), { labels: [{ name: 'ux', color: '#0075ca', description: undefined }] });
    assert.deepEqual(t.issues.items[0].labels, [{ name: 'ux', color: '#0075ca', description: undefined }], 'the board shows them at once');
    assert.deepEqual(nexura.seen.find((s) => s.path.endsWith('/labels'))?.body, { add: ['ux'], remove: [] });

    assert.equal(await t.merge(5, 'squash', true, false), 'Las directivas no se cumplen');

    const file = path.join(dir, 'review.md');
    writeFileSync(file, 'Round 2: all good');
    assert.equal(await t.review(5, file), 'https://dev.azure.com/x?discussionId=3');
    assert.deepEqual(nexura.seen.find((s) => s.path.endsWith('/review'))?.body, { body: 'Round 2: all good' });
  } finally {
    nexura.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nexura: without Nexura the boards say how to get it', async () => {
  const t = new NexuraTracker('/code/shop', () => {}, () => {}, undefined);
  await t.refresh();
  assert.match(t.issues.error ?? '', /npm run start:all/);
  assert.match((await t.comment('issue', 1, 'hola')).error ?? '', /npm run start:all/);
});
