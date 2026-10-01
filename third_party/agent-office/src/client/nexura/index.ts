// nexura: what Nexura adds to the 3D office, installed from main.ts like a feature: the trophy case
// and the ducks you can use (built on each floor by nexuraFixture, see achievements.ts), and on Azure
// DevOps floors, the windows saying "Azure DevOps" where they say "GitHub" (see external.ts).
import type { Ctx } from '../core/context';
import { aside, hintTitle, key, onE } from '../core/hint';
import { store } from '../state';
import { nexuraInteract, nexuraThingHint } from './achievements';
import { watchForgeWords } from './external';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../world/types' {
  interface InteractKinds {
    nexura: true;
  }
  interface Interactable {
    /** nexura: which of Nexura's things it is: 'trophies', or a duck ('duck-3'). */
    nexura?: string;
  }
}

export function installNexura(ctx: Ctx) {
  ctx.interactions.define('nexura', {
    reach: 4,
    hint: (it) => nexuraThingHint(it, hintTitle, key, aside),
    use: onE(nexuraInteract),
  });
  watchForgeWords(() => store.project);
}
