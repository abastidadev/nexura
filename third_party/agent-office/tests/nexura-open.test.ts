import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { handleOpen, openRequest } from '../src/server/nexura/open.js';

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

test('nexura: rebuild open requests field by field', () => {
  assert.deepEqual(openRequest({ kind: 'run', runId: 'run-42', extra: 'ignored' }), { kind: 'run', runId: 'run-42' });
  assert.deepEqual(openRequest({ kind: 'new-run', ticketId: '42', source: 'azure', repoDir: 'C:/app' }), { kind: 'new-run', ticketId: '42', source: 'azure', repoDir: 'C:/app' });
  assert.equal(openRequest({ kind: 'run', runId: '../admin' }), undefined);
  assert.equal(openRequest({ kind: 'new-run', ticketId: 'abc', source: 'github' }), undefined);
});

test('nexura: relay an open request only for an authenticated same-origin office user', async () => {
  const previous = process.env.NEXURA_URL;
  process.env.NEXURA_URL = 'http://127.0.0.1:4310';
  try {
    const calls: { url: string; body?: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ windows: 1 }), { status: 200 });
    }) as typeof fetch;

    const ok = response();
    await handleOpen(request('POST', JSON.stringify({ kind: 'run', runId: 'run-42', extra: 'ignored' })), ok.res, () => true, fetcher);
    assert.equal(ok.sent().status, 200);
    assert.equal(calls[0].url, 'http://127.0.0.1:4310/api/ui/open');
    assert.deepEqual(JSON.parse(calls[0].body!), { kind: 'run', runId: 'run-42' });

    const forbidden = response();
    await handleOpen(request('POST', JSON.stringify({ kind: 'run', runId: 'run-42' })), forbidden.res, () => false, fetcher);
    assert.equal(forbidden.sent().status, 403);
    assert.equal(calls.length, 1);
  } finally {
    if (previous === undefined) delete process.env.NEXURA_URL;
    else process.env.NEXURA_URL = previous;
  }
});
