import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { achievementEvent, handleAchievements } from '../src/server/nexura/achievements.js';

test('nexura: only the office events Nexura knows go through, rebuilt field by field', () => {
  assert.deepEqual(achievementEvent({ kind: 'use', what: 'dog', extra: 'x' }), { kind: 'use', what: 'dog' });
  assert.deepEqual(achievementEvent({ kind: 'duck', duck: 3 }), { kind: 'duck', duck: 3 });
  assert.deepEqual(achievementEvent({ kind: 'secret', what: 'konami' }), { kind: 'secret', what: 'konami' });
  assert.equal(achievementEvent({ kind: 'use', what: 'shell' }), undefined);
  assert.equal(achievementEvent({ kind: 'duck', duck: 6 }), undefined);
  assert.equal(achievementEvent({ kind: 'duck', duck: 1.5 }), undefined);
  assert.equal(achievementEvent({ kind: 'secret', what: 'rm' }), undefined);
  assert.equal(achievementEvent('duck'), undefined);
});

function request(method: string, body = ''): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.method = method;
  (req as unknown as PassThrough).end(body);
  return req;
}

function response(): { res: http.ServerResponse; sent: () => { status: number; body: unknown } } {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk: string) {
      text = chunk;
    },
  } as unknown as http.ServerResponse;
  return { res, sent: () => ({ status, body: JSON.parse(text) }) };
}

test('nexura: the office relays a checked event to Nexura, and refuses cross-origin posts', async () => {
  const previous = process.env.NEXURA_URL;
  process.env.NEXURA_URL = 'http://127.0.0.1:4310';
  try {
    const calls: { url: string; body?: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ unlocked: [] }), { status: 200 });
    }) as typeof fetch;

    const ok = response();
    await handleAchievements(request('POST', JSON.stringify({ kind: 'duck', duck: 2, sneaky: true })), ok.res, () => true, fetcher);
    assert.equal(ok.sent().status, 200);
    assert.equal(calls[0].url, 'http://127.0.0.1:4310/api/achievements/office');
    assert.deepEqual(JSON.parse(calls[0].body!), { kind: 'duck', duck: 2 });

    const forbidden = response();
    await handleAchievements(request('POST', JSON.stringify({ kind: 'duck', duck: 2 })), forbidden.res, () => false, fetcher);
    assert.equal(forbidden.sent().status, 403);

    const bad = response();
    await handleAchievements(request('POST', '{"kind":"use","what":"shell"}'), bad.res, () => true, fetcher);
    assert.equal(bad.sent().status, 400);
    assert.equal(calls.length, 1);
  } finally {
    if (previous === undefined) delete process.env.NEXURA_URL;
    else process.env.NEXURA_URL = previous;
  }
});
