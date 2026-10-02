// nexura: where Nexura's things stand on an office floor (built by client/nexura/*.ts), in one place so they don't land on each
// other or on upstream's. Picked from the floor's free space (x east, z south; the north wall is at
// z -13, the east wall at x 18). `rotY` is the way each faces, 0 being +z (south), as in layout.ts.
// The floor is 10 m wider to the west than upstream's (see FLOOR): its rooms take that west wing,
// x -28 to -13. The control room against its west wall, at the end of the building; along its north
// wall the Hall of Fame and the shop; the game room in the middle; the south-west corner is the court's.
import { FLOOR } from './layout.js';
import { boxFootprint } from './maps/props.js';
import type { Rect } from './nav.js';

export const PLACES = {
  /** The shop's stall, its back to the north wall of the west wing, between the Hall of Fame and the mailbox. */
  shop: { x: -19.1, z: FLOOR.minZ + 0.45, rotY: 0 },
  /** Nexura's mailbox for issue cards, against the north wall just west of the Issues board. */
  inbox: { x: -17.3, z: FLOOR.minZ + 0.5, rotY: 0 },
  /** The control room's monitor wall, its back to the west wall (where its north window was), facing the room. */
  control: { x: FLOOR.minX + 0.15, z: -9.5, rotY: Math.PI / 2 },
  /** The board of PRs to review, by the stairs, facing the room. */
  reviews: { x: 0.6, z: 10.6, rotY: Math.PI },
  /** Today in numbers, by the whiteboard. */
  summary: { x: 1.4, z: -8.6, rotY: 0 },
  /** The quota vending machine, at the end of the kitchen counter. */
  vending: { x: -9.2, z: FLOOR.maxZ - 0.55, rotY: Math.PI },
  /** The Hall of Fame: its gallery wall against the north wall of the west wing, facing the room. */
  fame: { x: -23, z: FLOOR.minZ + 0.1, rotY: 0, length: 5.4 },
  /** The game room, in the middle of the west wing, well off the pods and clear of the court round the hoop: its rug (and the sign over its north edge) and its three games. */
  gameRoom: { x: -20, z: -1.5, width: 6, depth: 5 },
  futbolin: { x: -20, z: -1.1, rotY: 0 },
  trivia: { x: -22.3, z: -3.4, rotY: 0 },
  race: { x: -17.7, z: -3.4, rotY: 0 },
} as const;

/** The trophy case against the east wall (client/nexura/trophy-case.ts), facing into the room. */
const TROPHIES = { x: FLOOR.maxX - 0.27, z: -4.2, rotY: -Math.PI / 2 } as const;

/**
 * What of Nexura's stands on the floor, for walking round it (see obstacles in nav.ts): each one's
 * footprint, `w` across it and `d` front to back, its middle `ahead` in front of where it stands.
 */
export function nexuraObstacles(): Rect[] {
  const at = (p: { x: number; z: number; rotY: number }, w: number, d: number, ahead = 0): Rect => boxFootprint(p.x + Math.sin(p.rotY) * ahead, p.z + Math.cos(p.rotY) * ahead, w, d, p.rotY);
  return [
    at(PLACES.shop, 2, 0.8),
    at(PLACES.inbox, 0.6, 0.8),
    at(PLACES.control, 4.9, 1.3, 0.5),
    at(PLACES.reviews, 2.6, 0.4),
    at(PLACES.summary, 2, 0.4),
    at(PLACES.vending, 1, 0.84),
    at(PLACES.fame, PLACES.fame.length, 0.24),
    at(PLACES.futbolin, 1.6, 0.9),
    at(PLACES.trivia, 0.84, 0.8),
    at(PLACES.race, 1.7, 1.06),
    at(TROPHIES, 1.68, 0.56),
  ];
}
