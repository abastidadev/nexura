// nexura: Nexura's things on an office floor, built in this order after upstream's (see the line in
// floorPlan() in world/office/build.ts). Where each stands is in places.ts.
import { trophyFixture } from './achievements';
import { duckFixture } from './ducks';
import { shopFixture } from './shop';
import { inboxFixture } from './inbox';

export const nexuraFixtures = [trophyFixture, duckFixture, shopFixture, inboxFixture] as const;
