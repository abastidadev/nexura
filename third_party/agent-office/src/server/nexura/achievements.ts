// nexura: the trophies of Nexura (apps/server/src/achievements), for the office's trophy case and its
// hidden ducks. The browser asks the office (signed in, same origin), and the office asks Nexura at
// NEXURA_URL, the way the Azure DevOps boards do (tracker.ts): Nexura sends no CORS headers.
import type http from 'node:http';
import { nexuraUrl } from './tracker.js';

const MAX_BODY = 1024;
const USES = new Set([
  'desk', 'station', 'issues', 'pulls', 'services', 'queue', 'tv', 'coffee', 'decor', 'smoke', 'elevator', 'gong', 'dog',
  'jukebox', 'seat', 'whiteboard', 'cabinet', 'ladder', 'pole', 'meeting', 'bar', 'dj', 'golf', 'ball', 'bookshelf', 'trophies',
]);
const SECRETS = new Set(['konami', 'night-shift', 'hole-in-one']);
const DUCKS = 5;

/** Only the events Nexura knows, rebuilt field by field; undefined for anything else. */
export function achievementEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'use' && typeof r.what === 'string' && USES.has(r.what)) return { kind: 'use', what: r.what };
  if (r.kind === 'duck' && typeof r.duck === 'number' && Number.isInteger(r.duck) && r.duck >= 1 && r.duck <= DUCKS) return { kind: 'duck', duck: r.duck };
  if (r.kind === 'secret' && typeof r.what === 'string' && SECRETS.has(r.what)) return { kind: 'secret', what: r.what };
  return undefined;
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

/**
 * GET /api/nexura/achievements (the summary) and POST /api/nexura/achievements (something you did).
 * `sameOrigin` is the server's CSRF check for POSTs. Without NEXURA_URL there is nothing to ask: 404.
 */
export async function handleAchievements(req: http.IncomingMessage, res: http.ServerResponse, sameOrigin: () => boolean, fetcher: typeof fetch = fetch): Promise<void> {
  const base = nexuraUrl();
  if (!base) return reply(res, 404, { error: 'Nexura is not connected (start the office with npm run start:all)' });
  try {
    if (req.method === 'GET') {
      const r = await fetcher(`${base}/api/achievements`, { signal: AbortSignal.timeout(10_000) });
      return reply(res, r.ok ? 200 : 502, r.ok ? await r.json() : { error: `Nexura answered ${r.status}` });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
    if (!sameOrigin()) return reply(res, 403, { error: 'Forbidden' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return reply(res, 413, { error: 'Too large' });
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = achievementEvent(JSON.parse(body));
    } catch {
      event = undefined;
    }
    if (!event) return reply(res, 400, { error: 'Unknown event' });
    const r = await fetcher(`${base}/api/achievements/office`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    return reply(res, r.ok ? 200 : 502, r.ok ? await r.json() : { error: `Nexura answered ${r.status}` });
  } catch (err) {
    return reply(res, 502, { error: `Nexura is not reachable: ${(err as Error).message}` });
  }
}
