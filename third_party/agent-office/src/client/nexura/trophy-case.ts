// nexura: the trophy case and the rubber ducks as they stand in the office (see achievements.ts for
// what they show and what using them does).
import * as THREE from 'three';
import { FLOOR } from '../../shared/layout';
import { mesh, textPlane, toon } from '../world/toon';
import type { Collider, Interactable } from '../world/types';

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';

/** What the case needs to know of one achievement. */
interface Achievement {
  id: string;
  tier: Tier;
  unlockedAt?: string;
}

const TIER_ORDER: Tier[] = ['platinum', 'gold', 'silver', 'bronze'];
const TIER_METAL: Record<Tier, string> = { bronze: '#cd7f32', silver: '#d6dde6', gold: '#ffc940', platinum: '#bfe0ff' };

/**
 * The trophy case: against the east wall between the Services board and the TV, facing into the
 * room (-x). `width` runs along the wall.
 */
export const TROPHY_CASE = { x: FLOOR.maxX - 0.27, z: -4.2, width: 1.6, depth: 0.5, height: 2.1 } as const;


const SHELVES = 3;
const PER_SHELF = 6;

/** A cup turned on a lathe: foot, stem and bowl, facing up; about 0.2 m tall. */
const CUP = new THREE.LatheGeometry(
  [
    [0, 0],
    [0.055, 0],
    [0.055, 0.02],
    [0.022, 0.03],
    [0.014, 0.07],
    [0.02, 0.09],
    [0.07, 0.12],
    [0.075, 0.2],
    [0.066, 0.2],
    [0.058, 0.13],
    [0, 0.12],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  18,
);
const HANDLE = new THREE.TorusGeometry(0.03, 0.008, 6, 12, Math.PI);
const GEM = new THREE.OctahedronGeometry(0.035);
const cupMaterials = new Map<string, THREE.Material>();

function cupMaterial(tier: Tier, won: boolean): THREE.Material {
  const key = won ? tier : 'locked';
  let m = cupMaterials.get(key);
  if (!m) {
    m = won ? toon(TIER_METAL[tier], { emissive: tier === 'platinum' || tier === 'gold' ? TIER_METAL[tier] : undefined }) : toon('#8d99ae', { transparent: true, opacity: 0.35 });
    if (won && (tier === 'platinum' || tier === 'gold')) (m as THREE.MeshToonMaterial).emissiveIntensity = 0.25;
    cupMaterials.set(key, m);
  }
  return m;
}

function cup(tier: Tier, won: boolean): THREE.Group {
  const g = new THREE.Group();
  const mat = cupMaterial(tier, won);
  g.add(mesh(CUP, mat, 0, 0, 0, false));
  for (const side of [-1, 1]) {
    const handle = mesh(HANDLE, mat, side * 0.072, 0.165, 0, false);
    handle.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(handle);
  }
  // The platinum one carries a gem.
  if (won && tier === 'platinum') g.add(mesh(GEM, cupMaterial('platinum', true), 0, 0.25, 0, false));
  return g;
}

export interface CaseView {
  /** What it shows now, to skip rebuilding it when a poll brings nothing new. */
  shown: string;
  shelves: THREE.Group;
  plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shelfY: number[];
  inner: number;
}

/** Puts on the shelves the cups you've won (the best first) and ghosts of the ones still to win. */
export function fillCase(view: CaseView, all: readonly Pick<Achievement, 'id' | 'tier' | 'unlockedAt'>[], label: string) {
  const shownNow = `${label}|${all.map((a) => `${a.id}${a.unlockedAt ? '+' : ''}`).join()}`;
  if (shownNow === view.shown) return;
  view.shown = shownNow;
  view.shelves.clear();
  const won = all.filter((a) => a.unlockedAt).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  const locked = all.filter((a) => !a.unlockedAt).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  const shown = [...won.map((a) => [a.tier, true] as const), ...locked.map((a) => [a.tier, false] as const)].slice(0, SHELVES * PER_SHELF);
  const step = view.inner / PER_SHELF;
  shown.forEach(([tier, isWon], i) => {
    // The top shelf first, where they're easiest to see.
    const shelf = SHELVES - 1 - Math.floor(i / PER_SHELF);
    const c = cup(tier, isWon);
    const size = tier === 'platinum' ? 1.35 : tier === 'gold' ? 1.15 : 1;
    c.scale.setScalar(size);
    c.position.set(-view.inner / 2 + step * ((i % PER_SHELF) + 0.5), view.shelfY[shelf], 0.02);
    view.shelves.add(c);
  });
  const next = textPlane(label, { size: 34, bg: '#fffaf3' });
  view.plaque.geometry.dispose();
  view.plaque.material.map?.dispose();
  view.plaque.material.dispose();
  view.plaque.geometry = next.geometry;
  view.plaque.material = next.material;
}

export function buildCase(label: string): { group: THREE.Group; collider: Collider; interactable: Interactable; view: CaseView } {
  const { width: W, depth: D, height: H } = TROPHY_CASE;
  // Built facing +z, back against z = -D/2.
  const g = new THREE.Group();
  const wood = toon('#5c3d2e');
  const trim = toon('#e9c46a');
  const glass = toon('#caf0f8', { transparent: true, opacity: 0.16 });
  glass.depthWrite = false;
  const base = 0.5;
  g.add(mesh(new THREE.BoxGeometry(W, base, D), wood, 0, base / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(W + 0.04, 0.03, D + 0.04), trim, 0, base + 0.015, 0));
  g.add(mesh(new THREE.BoxGeometry(W, 0.03, D), toon('#3d2a1f'), 0, H - 0.015, 0));
  g.add(mesh(new THREE.BoxGeometry(W + 0.06, 0.08, D + 0.06), wood, 0, H + 0.04, 0));
  g.add(mesh(new THREE.BoxGeometry(W, H - base, 0.02), toon('#1d3557'), 0, (H + base) / 2, -D / 2 + 0.01));
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.04, H - base, 0.04), wood, sx * (W / 2 - 0.02), (H + base) / 2, D / 2 - 0.02));
    g.add(mesh(new THREE.BoxGeometry(0.04, H - base, 0.04), wood, sx * (W / 2 - 0.02), (H + base) / 2, -D / 2 + 0.02));
    g.add(mesh(new THREE.BoxGeometry(0.02, H - base, D - 0.06), glass, sx * (W / 2 - 0.01), (H + base) / 2, 0, false));
  }
  g.add(mesh(new THREE.BoxGeometry(W - 0.08, H - base, 0.015), glass, 0, (H + base) / 2, D / 2 - 0.01, false));
  // A warm strip of light under the top.
  g.add(mesh(new THREE.BoxGeometry(W - 0.12, 0.02, 0.04), toon('#fff3b0', { emissive: '#fff3b0' }), 0, H - 0.05, D / 2 - 0.08, false));
  const inner = W - 0.14;
  const gap = (H - base - 0.12) / SHELVES;
  const shelfY: number[] = [];
  for (let s = 0; s < SHELVES; s++) {
    const y = base + 0.03 + s * gap;
    shelfY.push(y + 0.012);
    if (s > 0) g.add(mesh(new THREE.BoxGeometry(inner, 0.024, D - 0.08), toon('#dfe7fd', { transparent: true, opacity: 0.5 }), 0, y, 0, false));
  }
  const shelves = new THREE.Group();
  g.add(shelves);
  const plaque = textPlane(label, { size: 34, bg: '#fffaf3' });
  plaque.position.set(0, H + 0.34, 0.02);
  g.add(plaque);
  // A little brass sign on the base.
  const sign = textPlane('Vitrina de logros · E', { size: 22, bg: '#e9c46a' });
  sign.position.set(0, base / 2 + 0.05, D / 2 + 0.005);
  g.add(sign);

  const view: CaseView = { shown: '', shelves, plaque, shelfY, inner };
  // Facing into the room (-x) from the east wall.
  g.position.set(TROPHY_CASE.x, 0, TROPHY_CASE.z);
  g.rotation.y = -Math.PI / 2;
  const collider: Collider = { minX: FLOOR.maxX - D - 0.06, maxX: FLOOR.maxX, minZ: TROPHY_CASE.z - W / 2 - 0.04, maxZ: TROPHY_CASE.z + W / 2 + 0.04, top: H + 0.08 };
  const interactable: Interactable = { kind: 'nexura', nexura: 'trophies', x: FLOOR.maxX - D - 1.1, z: TROPHY_CASE.z, radius: 1.6 };
  g.userData.interact = interactable;
  return { group: g, collider, interactable, view };
}

/** A rubber duck about 0.2 m long, facing +z. */
export function buildDuck(): THREE.Group {
  const g = new THREE.Group();
  const yellow = toon('#ffd60a');
  const body = mesh(new THREE.SphereGeometry(0.09, 14, 10), yellow, 0, 0.07, 0);
  body.scale.set(1, 0.72, 1.25);
  g.add(body);
  const tail = mesh(new THREE.ConeGeometry(0.04, 0.07, 8), yellow, 0, 0.1, -0.11);
  tail.rotation.x = -Math.PI / 3;
  g.add(tail);
  g.add(mesh(new THREE.SphereGeometry(0.058, 12, 10), yellow, 0, 0.16, 0.06));
  const beak = mesh(new THREE.ConeGeometry(0.025, 0.06, 8), toon('#f77f00'), 0, 0.15, 0.13);
  beak.rotation.x = Math.PI / 2;
  g.add(beak);
  for (const sx of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.011, 6, 6), toon('#1b1b1b'), sx * 0.028, 0.18, 0.105, false));
  return g;
}

/** A duck squashes and springs back when you pick it up. */
export function squeak(duck: THREE.Group) {
  const t0 = performance.now();
  const tick = () => {
    const t = (performance.now() - t0) / 400;
    if (t >= 1) {
      duck.scale.setScalar(1);
      return;
    }
    const s = 1 - Math.sin(t * Math.PI) * 0.25;
    duck.scale.set(1 + (1 - s) * 0.6, s, 1 + (1 - s) * 0.6);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
