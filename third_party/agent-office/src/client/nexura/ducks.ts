// nexura: the rubber ducks. Five hide on every floor, and every week (an ISO week, the same "season"
// Nexura counts) they move to five other hiding places of the ones below. Finding one counts for the
// trophies (duck 1 to 5) and, once per season, pays coins; all five of a season pay a bonus.
import * as THREE from 'three';
import { BALCONY, BOOKSHELF, CABINET, FLOOR, GONG, JUKEBOX, LOFT, MEETING_TABLE, WHITEBOARD } from '../../shared/layout';
import { aside, hintTitle, key } from '../core/hint';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { officeToast, report, trophyState } from './achievements';
import { nexuraThing } from './things';
import { buildDuck, squeak } from './trophy-case';
import { loadWallet, nexura, wallet } from './wallet';

/**
 * Where ducks can hide: [x, y, z], each checked to be in sight from somewhere you can stand (pick a
 * new one the same way: paint the duck magenta and count its pixels from around it).
 */
export const DUCK_SPOTS: readonly (readonly [number, number, number])[] = [
  [BOOKSHELF.x + 0.55, BOOKSHELF.height + 0.07, BOOKSHELF.z - 0.02],
  [-12.3, 1.03, 12.35],
  [16.45, 0, -12.7],
  // Against the wall: the south-east corner gets a pumpkin at Halloween (world/holiday.ts).
  [BALCONY.maxX - 0.35, 0, BALCONY.minZ + 0.35],
  [FLOOR.maxX - 0.75, LOFT.y + 0.52, (LOFT.minZ + LOFT.maxZ) / 2 + 0.45],
  [JUKEBOX.x - 0.05, JUKEBOX.height + 0.01, JUKEBOX.z],
  [CABINET.x, CABINET.height + 0.01, CABINET.z],
  [MEETING_TABLE.x + 1.4, MEETING_TABLE.height + 0.01, MEETING_TABLE.z],
  [GONG.x + 1.25, 0, GONG.z + 0.2],
  [WHITEBOARD.x + WHITEBOARD.width / 2 + 0.35, 0, WHITEBOARD.z],
  [-14.6, 1.03, 12.35],
  [LOFT.minX + 1.2, LOFT.y + 0.01, LOFT.minZ + 0.6],
];

export const DUCKS = 5;

/** The ISO week of `date`, as Nexura writes it (`2026-W40`). */
export function duckSeason(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The five spots of a season, the same in every browser: a shuffle seeded by the season. */
export function seasonSpots(season: string): (readonly [number, number, number])[] {
  let h = 2166136261;
  for (let i = 0; i < season.length; i++) h = Math.imul(h ^ season.charCodeAt(i), 16777619);
  const spots = [...DUCK_SPOTS];
  for (let i = spots.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [spots[i], spots[j]] = [spots[j]!, spots[i]!];
  }
  return spots.slice(0, DUCKS);
}

const built: { group: THREE.Group; n: number }[] = [];

export const duckFixture: Fixture = () => {
  const group = new THREE.Group();
  const interactables: Interactable[] = [];
  seasonSpots(duckSeason()).forEach(([x, y, z], i) => {
    const duck = buildDuck();
    duck.position.set(x, y, z);
    duck.rotation.y = [Math.PI, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.8, Math.PI / 2][i] ?? 0;
    const it: Interactable = { kind: 'nexura', nexura: `duck-${i + 1}`, x, z, ...(y > 2.5 ? { y: LOFT.y } : {}), radius: 1.3 };
    duck.userData.interact = it;
    group.add(duck);
    interactables.push(it);
    built.push({ group: duck, n: i + 1 });
  });
  return { group, interactables };
};

function duckOf(it: Interactable): number {
  return Number(/^duck-(\d)$/.exec(it.nexura ?? '')?.[1] ?? 0);
}

/** Found this season, as Nexura's wallet says. */
function foundThisSeason(): number[] {
  const w = wallet();
  return w && w.ducks.season === duckSeason() ? w.ducks.found : [];
}

nexuraThing('duck-', {
  hint: (it) => {
    const n = duckOf(it);
    const found = foundThisSeason();
    const had = found.includes(n);
    return { k: `duck${n}${had}${found.length}`, parts: [hintTitle(had ? '🦆 Patito de goma' : '🦆 ¿Y esto?'), had ? aside(`ya lo encontraste esta semana · ${found.length}/${DUCKS}`) : key('E', 'Cogerlo')] };
  },
  use: (it, k) => {
    if (k !== 'E') return;
    const n = duckOf(it);
    if (!trophyState().connected && !wallet()) return officeToast('🦆 ¡Cuac! Arranca la oficina con Nexura (npm run start:all) para que cuente.');
    if (foundThisSeason().includes(n)) return officeToast(`🦆 Este ya lo encontraste esta semana · ${foundThisSeason().length}/${DUCKS}. El lunes se esconden en otro sitio.`);
    const quack = built.find((d) => d.n === n)?.group;
    if (quack) squeak(quack);
    void report({ kind: 'duck', duck: n });
    void nexura<{ paid: number }>('rewards/office', { kind: 'duck', duck: n, season: duckSeason() })
      .then(async ({ paid }) => {
        await loadWallet();
        officeToast(`🦆 ¡Cuac! Patito ${foundThisSeason().length}/${DUCKS} de la semana${paid ? ` · +${paid} 🪙` : ''}`);
      })
      .catch((err: Error) => officeToast(`🦆 ¡Cuac! (${err.message})`));
  },
});
