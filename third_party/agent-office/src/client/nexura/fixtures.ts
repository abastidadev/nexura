// nexura: Nexura's things on an office floor, built in this order after upstream's (see the line in
// floorPlan() in world/office/build.ts). Where each stands is in places.ts.
import { trophyFixture } from './achievements';
import { duckFixture } from './ducks';
import { shopFixture } from './shop';
import { inboxFixture } from './inbox';
import { controlRoomFixture } from './control-room';
import { reviewsFixture, todayFixture, vendingFixture } from './boards';
import { fameFixture } from './fame';
import { futbolinFixture, gameRoomFixture, raceFixture, triviaFixture } from './games';

export const nexuraFixtures = [trophyFixture, duckFixture, shopFixture, inboxFixture, controlRoomFixture, reviewsFixture, todayFixture, vendingFixture, fameFixture, gameRoomFixture, futbolinFixture, triviaFixture, raceFixture] as const;
