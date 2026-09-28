// nexura: with the office in its own window, what you open from it (a run, "Resolve with Nexura") shows
// in the Nexura window you already have open, which navigates without taking the focus. The browser
// asks the office, and the office asks Nexura (apps/server/src/office/office-open.ts), which tells
// its window over its WebSocket. GET says how many Nexura windows there are, and where Nexura is.
import type http from 'node:http';
import { nexuraUrl } from './tracker.js';

const MAX_BODY = 2048;

/** Only what Nexura can open, rebuilt field by field; undefined for anything else. */
export function openRequest(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'run' && typeof r.runId === 'string' && /^[\w-]{1,40}$/.test(r.runId)) return { kind: 'run', runId: r.runId };
  if (r.kind === 'new-run' && typeof r.ticketId === 'string' && /^\d{1,12}$/.test(r.ticketId) && (r.source === 'azure' || r.source === 'github')) {
    return { kind: 'new-run', ticketId: r.ticketId, source: r.source, ...(typeof r.repoDir === 'string' ? { repoDir: r.repoDir.slice(0, 1024) } : {}) };
  }
  return undefined;
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

/** GET/POST /api/nexura/open. `sameOrigin` is the server's CSRF check for POSTs. */
export async function handleOpen(req: http.IncomingMessage, res: http.ServerResponse, sameOrigin: () => boolean, fetcher: typeof fetch = fetch): Promise<void> {
  const base = nexuraUrl();
  if (!base) return reply(res, 200, { windows: 0 });
  try {
    if (req.method === 'GET') {
      const r = await fetcher(`${base}/api/ui/windows`, { signal: AbortSignal.timeout(5000) });
      const windows = r.ok ? Number(((await r.json()) as { windows?: unknown }).windows) || 0 : 0;
      return reply(res, 200, { windows, url: base });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
    if (!sameOrigin()) return reply(res, 403, { error: 'Forbidden' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return reply(res, 413, { error: 'Too large' });
    }
    let request: Record<string, string> | undefined;
    try {
      request = openRequest(JSON.parse(body));
    } catch {
      request = undefined;
    }
    if (!request) return reply(res, 400, { error: 'Unknown request' });
    const r = await fetcher(`${base}/api/ui/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    return reply(res, r.ok ? 200 : 502, r.ok ? await r.json() : { error: `Nexura answered ${r.status}` });
  } catch (err) {
    return reply(res, 502, { error: `Nexura is not reachable: ${(err as Error).message}` });
  }
}
