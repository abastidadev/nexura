// nexura: the office's HTTP routes for Nexura, listed in http/routes/index.ts. The bridge is made the
// first time something asks for it, one per office (tests start several).
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import type { Route } from '../http/router.js';
import { sameOrigin } from '../http/util.js';
import { NexuraBridge } from './bridge.js';
import { handleAchievements } from './achievements.js';
import { handleOpen } from './open.js';

const bridges = new WeakMap<Ctx, NexuraBridge>();

/** Nexura's runs at this office's desks (see bridge.ts). */
export function nexuraBridge(ctx: Ctx): NexuraBridge {
  let bridge = bridges.get(ctx);
  if (!bridge) {
    bridge = new NexuraBridge(process.env.NEXURA_OFFICE_TOKEN, { floors: () => ctx.floors.values(), emit: (f, msg) => ctx.toFloor(f as Floor, msg) });
    bridges.set(ctx, bridge);
  }
  return bridge;
}

export const nexuraRoutes = {
  /** Nexura posts its live runs here with its own token, not a browser session. */
  workers: { path: '/nexura/workers', auth: 'public', handle: (ctx, { req, res }) => nexuraBridge(ctx).handle(req, res) },
  achievements: { path: '/api/nexura/achievements', auth: 'session', handle: (ctx, { req, res }) => handleAchievements(req, res, () => sameOrigin(req, ctx.cfg)) },
  open: { path: '/api/nexura/open', auth: 'session', handle: (ctx, { req, res }) => handleOpen(req, res, () => sameOrigin(req, ctx.cfg)) },
} satisfies Record<string, Route>;
