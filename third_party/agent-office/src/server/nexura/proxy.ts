// nexura: the rest of what the office asks Nexura for, besides the trophies (achievements.ts): the
// wallet and the shop, bets, the trivia, the digest (control room, Hall of Fame, today, reviews,
// quota) and continuing a paused flow. The browser asks the office (signed in, same origin) and the
// office asks NEXURA_URL; only the paths below go through, and Nexura checks every body itself.
import type http from 'node:http';
import { nexuraUrl } from './tracker.js';

const MAX_BODY = 4096;

/** Where a request to the office goes in Nexura, or undefined when it may not go there at all. */
export function nexuraTarget(method: string | undefined, path: string): string | undefined {
  if (method === 'GET') {
    if (path === '/api/nexura/rewards') return '/api/rewards';
    if (path === '/api/nexura/rewards/trivia') return '/api/rewards/trivia';
    if (path === '/api/nexura/digest') return '/api/office/digest';
    return undefined;
  }
  if (method === 'POST') {
    const reward = /^\/api\/nexura\/rewards\/(buy|equip|bets|office|trivia)$/.exec(path);
    if (reward) return `/api/rewards/${reward[1]}`;
    const run = /^\/api\/nexura\/runs\/([\w-]{1,80})\/continue$/.exec(path);
    if (run) return `/api/office/runs/${run[1]}/continue`;
  }
  return undefined;
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

/** Passes a request on to Nexura and its answer (status and JSON) back. `sameOrigin` guards the POSTs. */
export async function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, path: string, sameOrigin: () => boolean, fetcher: typeof fetch = fetch): Promise<void> {
  const base = nexuraUrl();
  if (!base) return reply(res, 404, { error: 'Nexura no está conectada (arranca la oficina con npm run start:all)' });
  const target = nexuraTarget(req.method, path);
  if (!target) return reply(res, 404, { error: 'Not found' });
  let body: string | undefined;
  if (req.method === 'POST') {
    if (!sameOrigin()) return reply(res, 403, { error: 'Forbidden' });
    body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return reply(res, 413, { error: 'Too large' });
    }
    try {
      const parsed: unknown = JSON.parse(body || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = JSON.stringify(parsed);
    } catch {
      return reply(res, 400, { error: 'JSON no válido' });
    }
  }
  try {
    const r = await fetcher(`${base}${target}`, {
      method: req.method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const answer = await r.json().catch(() => ({ error: `Nexura answered ${r.status}` }));
    return reply(res, r.status, answer);
  } catch (err) {
    return reply(res, 502, { error: `Nexura no responde: ${(err as Error).message}` });
  }
}
