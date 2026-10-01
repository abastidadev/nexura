// nexura: what Nexura adds to the 3D office, installed from main.ts like a feature. Every thing of
// Nexura's you can use is the one interactable kind 'nexura' (see things.ts); its fixtures are built
// on each floor after upstream's (fixtures.ts). Here: the dispatcher, the coins in the corner and what
// everyone wears from the shop, and on Azure DevOps floors the windows saying "Azure DevOps".
import './ui.css';
import type { Ctx } from '../core/context';
import type { Parts } from '../core/parts';
import { store } from '../state';
import type { Person } from '../world/character';
import { animate, dress, forget } from './cosmetics';
import { watchForgeWords } from './external';
import { openShop } from './shop';
import { thingOf } from './things';
import { nexura, sendOutfit, startWallet, wallet } from './wallet';
import { sanitizeOutfit } from '../../shared/nexura-outfit';
import './achievements';
import './ducks';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../world/types' {
  interface InteractKinds {
    nexura: true;
  }
  interface Interactable {
    /** nexura: which of Nexura's things it is ('trophies', 'duck-3', 'shop'…), see things.ts. */
    nexura?: string;
  }
}

export type NexuraParts = Pick<Parts, 'peers' | 'me'>;

export function installNexura(ctx: Ctx, parts: NexuraParts) {
  ctx.interactions.define('nexura', {
    reach: 4,
    hint: (it) => thingOf(it)?.hint(it) ?? { k: '', parts: [] },
    use: (it, key) => thingOf(it)?.use(it, key),
  });
  watchForgeWords(() => store.project);

  startWallet(ctx.net, openShop);
  // Back in the office (or after a reconnect, which starts you over): your outfit, and the day's visit.
  ctx.messages.on('welcome', () => {
    sendOutfit();
    void nexura('rewards/office', { kind: 'visit' }).catch(() => undefined);
  });

  // What everyone on the floor wears, yourself included, and their pets and trails.
  let dressed = new Set<Person>();
  ctx.ticks.add('others', ({ dt, t }) => {
    const now = new Set<Person>();
    for (const [id, r] of parts.peers.remotes) {
      dress(r.person, store.peers.get(id)?.nexura, ctx.scene);
      now.add(r.person);
    }
    dress(parts.me, sanitizeOutfit(wallet()?.equipped), ctx.scene);
    now.add(parts.me);
    for (const person of dressed) if (!now.has(person)) forget(person, ctx.scene);
    dressed = now;
    animate(now, ctx.scene, dt, t);
  });
}
