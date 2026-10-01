// nexura: where Nexura's things stand on an office floor, in one place so they don't land on each
// other or on upstream's. Picked from the floor's free space (x east, z south; the north wall is at
// z -13, the east wall at x 18). `rotY` is the way each faces, 0 being +z (south), as in layout.ts.
import { FLOOR } from '../../shared/layout';

export const PLACES = {
  /** The shop's stall, near the elevator where everyone comes in. */
  shop: { x: 13.1, z: -7.4, rotY: -Math.PI / 2 },
  /** Nexura's mailbox for issue cards, by the west wall under the Issues board's corner. */
  inbox: { x: FLOOR.minX + 1.2, z: -9.2, rotY: Math.PI / 2 },
  /** The control room's monitor wall, freestanding in the west aisle, facing the pods. */
  control: { x: FLOOR.minX + 2.2, z: 0.6, rotY: Math.PI / 2 },
  /** The board of PRs to review, by the stairs, facing the room. */
  reviews: { x: 0.6, z: 10.6, rotY: Math.PI },
  /** Today in numbers, by the whiteboard. */
  summary: { x: 1.4, z: -8.6, rotY: 0 },
  /** The quota vending machine, at the end of the kitchen counter. */
  vending: { x: -9.2, z: FLOOR.maxZ - 0.55, rotY: Math.PI },
  /** The Hall of Fame: a freestanding gallery wall between the pods and the lounge, facing the lounge (clear of the exit door). */
  fame: { x: 5.0, z: -1.2, rotY: Math.PI / 2, length: 5.4 },
  /** The game room: the futbolín table and the trivia cabinet, between the pods and the lounge. */
  futbolin: { x: 5.6, z: 5.4, rotY: 0 },
  trivia: { x: 3.4, z: 7.9, rotY: Math.PI },
} as const;
