// nexura: Nexura's trophies in the office (apps/server/src/achievements in Nexura). A glass trophy
// case against the east wall shows the cups you've won and opens the full list; five rubber ducks
// hide around the room; and a few secrets (the Konami code, a visit at night, a hole in one) count
// too. What you do goes to Nexura through the office's server (server/nexura/achievements.ts).
// When the office is framed by Nexura, Nexura shows the trophy toast; on its own, the office does.
import * as THREE from 'three';
import { BALCONY, BOOKSHELF, FLOOR, LOFT } from '../../shared/layout';
import { h, openModal } from '../ui/dom';
import { mesh, textPlane, toon } from '../world/toon';
import type { Collider, Interactable } from '../world/office';

type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';
type Category = 'tickets' | 'reviews' | 'constancy' | 'office' | 'legend';

/** One achievement as Nexura sends it (AchievementView). */
interface Achievement {
  id: string;
  tier: Tier;
  category: Category;
  icon: string;
  title: string;
  description: string;
  secret: boolean;
  unlockedAt?: string;
  progress?: { current: number; goal: number; extra?: { current: number; goal: number; label: string } };
}

interface Summary {
  achievements: Achievement[];
  unlocked: number;
  total: number;
  points: number;
  maxPoints: number;
  ducks: number[];
}

type OfficeEvent = { kind: 'use'; what: string } | { kind: 'duck'; duck: number } | { kind: 'secret'; what: 'konami' | 'night-shift' | 'hole-in-one' };

const TIER_LABEL: Record<Tier, string> = { bronze: 'Bronce', silver: 'Plata', gold: 'Oro', platinum: 'Platino' };
const TIER_POINTS: Record<Tier, number> = { bronze: 15, silver: 30, gold: 90, platinum: 180 };
const TIER_ORDER: Tier[] = ['platinum', 'gold', 'silver', 'bronze'];
const TIER_METAL: Record<Tier, string> = { bronze: '#cd7f32', silver: '#d6dde6', gold: '#ffc940', platinum: '#bfe0ff' };
const CATEGORY_LABEL: Record<Category, string> = { tickets: 'Tickets', reviews: 'Revisiones', constancy: 'Constancia', office: 'Oficina 3D', legend: 'Leyenda' };
/** What the office's interactables are called by Nexura (its OfficeUse). */
const USES = new Set(['desk', 'station', 'issues', 'pulls', 'services', 'queue', 'tv', 'coffee', 'decor', 'smoke', 'elevator', 'gong', 'dog', 'jukebox', 'seat', 'whiteboard', 'cabinet', 'ladder', 'pole', 'meeting', 'bar', 'dj', 'golf', 'ball', 'bookshelf']);
const POLL_MS = 30_000;
const TOAST_MS = 20_000;
const GOLF_KEY = 'agent-office.golf';
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/**
 * The trophy case: against the east wall between the Services board and the TV, facing into the
 * room (-x). `width` runs along the wall.
 */
export const TROPHY_CASE = { x: FLOOR.maxX - 0.27, z: -4.2, width: 1.6, depth: 0.5, height: 2.1 } as const;

/** Where the ducks hide: [x, y, z]. On the bookshelf, by the fridge, behind a plant, on the balcony, and upstairs. */
export const DUCKS: readonly (readonly [number, number, number])[] = [
  [BOOKSHELF.x + 0.55, BOOKSHELF.height + 0.07, BOOKSHELF.z - 0.02],
  [-12.3, 1.03, 12.35],
  [16.45, 0, -12.7],
  [BALCONY.maxX - 0.35, 0, BALCONY.maxZ - 0.35],
  [FLOOR.maxX - 0.75, LOFT.y + 0.52, (LOFT.minZ + LOFT.maxZ) / 2 + 0.45],
];

// ---- Talking to Nexura ------------------------------------------------------------------------------

let summary: Summary | null = null;
/** False until Nexura answered once; the office without Nexura has no trophies. */
let connected = false;
/** Trophies already known, so a poll doesn't announce them again. */
let known: Set<string> | null = null;
const onChange = new Set<() => void>();

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/nexura/achievements', { headers: { accept: 'application/json' } });
    if (!r.ok) {
      connected = false;
      return;
    }
    const next = (await r.json()) as Summary;
    connected = true;
    const won = next.achievements.filter((a) => a.unlockedAt);
    if (known) for (const a of won) if (!known.has(a.id)) showTrophy(a);
    known = new Set(won.map((a) => a.id));
    summary = next;
    onChange.forEach((fn) => fn());
  } catch {
    connected = false;
  }
}

async function report(event: OfficeEvent): Promise<void> {
  if (!connected) return;
  try {
    const r = await fetch('/api/nexura/achievements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    if (!r.ok) return;
    const { unlocked } = (await r.json()) as { unlocked?: Achievement[] };
    for (const a of unlocked ?? []) {
      known?.add(a.id);
      showTrophy(a);
    }
    if (unlocked?.length || event.kind === 'duck') await load();
  } catch {
    // Nexura went away: nothing to count it on.
  }
}

/** When each thing was last reported, so leaning on E doesn't flood Nexura. */
const lastUse = new Map<string, number>();

/** Something in the office was used (the E key or a click on it). */
export function nexuraUse(kind: string, key: string): void {
  if (key !== 'E' || !USES.has(kind)) return;
  const now = performance.now();
  if (now - (lastUse.get(kind) ?? -Infinity) < 1200) return;
  lastUse.set(kind, now);
  void report({ kind: 'use', what: kind });
}

let started = false;

/** Loads the trophies, keeps them fresh, and listens for the office's secrets. Once per page. */
function start(): void {
  if (started) return;
  started = true;
  injectStyles();
  void load().then(() => {
    checkNight();
    checkGolf();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, POLL_MS);
  setInterval(checkNight, 5 * 60_000);
  setInterval(checkGolf, 3000);
  let at = 0;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"], .xterm')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      at = k === KONAMI[at] ? at + 1 : k === KONAMI[0] ? 1 : 0;
      if (at === KONAMI.length) {
        at = 0;
        void report({ kind: 'secret', what: 'konami' });
      }
    },
    true,
  );
}

let nightReported = false;
function checkNight() {
  if (nightReported || !connected || new Date().getHours() >= 5) return;
  nightReported = true;
  void report({ kind: 'secret', what: 'night-shift' });
}

let golfReported = false;
/** The office keeps your holes in one in this browser (main.ts, GOLF_KEY): any at all counts. */
function checkGolf() {
  if (golfReported || !connected) return;
  try {
    const holes = (JSON.parse(localStorage.getItem(GOLF_KEY) ?? '{}') as { holes?: unknown }).holes;
    if (typeof holes === 'number' && holes > 0) {
      golfReported = true;
      void report({ kind: 'secret', what: 'hole-in-one' });
    }
  } catch {
    // no storage in this window
  }
}

// ---- The trophy case and the ducks ------------------------------------------------------------------

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

interface CaseView {
  /** What it shows now, to skip rebuilding it when a poll brings nothing new. */
  shown: string;
  shelves: THREE.Group;
  plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shelfY: number[];
  inner: number;
}
const cases: CaseView[] = [];
const ducks: { group: THREE.Group; n: number }[] = [];

function plaqueText(): string {
  return summary ? `🏆 Logros · ${summary.unlocked}/${summary.total}` : '🏆 Logros';
}

/** Puts on the shelves the cups you've won (the best first) and ghosts of the ones still to win. */
function fillCase(view: CaseView) {
  const all = summary?.achievements ?? [];
  const shownNow = `${plaqueText()}|${all.map((a) => `${a.id}${a.unlockedAt ? '+' : ''}`).join()}`;
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
  const next = textPlane(plaqueText(), { size: 34, bg: '#fffaf3' });
  view.plaque.geometry.dispose();
  view.plaque.material.map?.dispose();
  view.plaque.material.dispose();
  view.plaque.geometry = next.geometry;
  view.plaque.material = next.material;
}

function buildCase(): { group: THREE.Group; collider: Collider; interactable: Interactable; view: CaseView } {
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
  const plaque = textPlane(plaqueText(), { size: 34, bg: '#fffaf3' });
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
function buildDuck(): THREE.Group {
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

/**
 * Adds Nexura's things to a floor's office: the trophy case and the ducks. Called once per office
 * built (see world/office.ts); starts talking to Nexura the first time.
 */
export function nexuraExtras(group: THREE.Group, colliders: Collider[], interactables: Interactable[]): void {
  start();
  const trophyCase = buildCase();
  group.add(trophyCase.group);
  colliders.push(trophyCase.collider);
  interactables.push(trophyCase.interactable);
  cases.push(trophyCase.view);
  fillCase(trophyCase.view);

  DUCKS.forEach(([x, y, z], i) => {
    const duck = buildDuck();
    duck.position.set(x, y, z);
    // Each looks somewhere a little different.
    duck.rotation.y = [Math.PI, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.8, Math.PI / 2][i] ?? 0;
    const it: Interactable = { kind: 'nexura', nexura: `duck-${i + 1}`, x, z, ...(y > 2.5 ? { y: LOFT.y } : {}), radius: 1.3 };
    duck.userData.interact = it;
    group.add(duck);
    interactables.push(it);
    ducks.push({ group: duck, n: i + 1 });
  });
}

onChange.add(() => cases.forEach(fillCase));

// ---- Using them -------------------------------------------------------------------------------------

function duckOf(it: Interactable): number {
  return Number(/^duck-(\d)$/.exec(it.nexura ?? '')?.[1] ?? 0);
}

/** E at the trophy case or at a duck. */
export function nexuraInteract(it: Interactable): void {
  const duck = duckOf(it);
  if (duck) {
    if (!connected) return officeToast('🦆 ¡Cuac! Arranca la oficina con Nexura (npm run start:all) para que cuente.');
    if (summary?.ducks.includes(duck)) return officeToast(`🦆 Este ya lo tenías · ${summary.ducks.length}/${DUCKS.length}`);
    const quack = ducks.find((d) => d.n === duck)?.group;
    if (quack) squeak(quack);
    void report({ kind: 'duck', duck }).then(() => officeToast(`🦆 ¡Cuac! Patito ${summary?.ducks.length ?? 1}/${DUCKS.length}`));
    return;
  }
  openTrophyRoom();
  void report({ kind: 'use', what: 'trophies' });
}

/** A duck squashes and springs back when you pick it up. */
function squeak(duck: THREE.Group) {
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

/** The hint bar at the trophy case or a duck. `title`, `key` and `aside` are main.ts's hint pieces. */
export function nexuraThingHint(
  it: Interactable,
  title: (text: string) => HTMLElement,
  key: (k: string, label: string) => HTMLElement,
  aside: (text: string) => HTMLElement,
): { k: string; parts: (HTMLElement | string)[] } {
  const duck = duckOf(it);
  if (duck) {
    const had = summary?.ducks.includes(duck);
    return { k: `duck${duck}${had}`, parts: [title(had ? '🦆 Patito de goma' : '🦆 ¿Y esto?'), had ? aside(`ya lo tienes · ${summary?.ducks.length}/${DUCKS.length}`) : key('E', 'Cogerlo')] };
  }
  const about = summary ? `${summary.unlocked}/${summary.total} · ${summary.points} pts` : connected ? '' : 'sin conexión con Nexura';
  return { k: `trophies${about}`, parts: [title('🏆 Vitrina de logros'), about ? aside(about) : '', key('E', 'Ver los logros')] };
}

// ---- The list of trophies ---------------------------------------------------------------------------

function medal(a: Pick<Achievement, 'tier' | 'icon'>, won: boolean): HTMLElement {
  return h('span.nx-ach-medal', { class: `${a.tier}${won ? '' : ' locked'}`, 'aria-hidden': 'true' }, h('span', {}, a.icon));
}

function card(a: Achievement): HTMLElement {
  const won = !!a.unlockedAt;
  const p = a.progress;
  const pct = p ? Math.round(((Math.min(1, p.current / p.goal) + (p.extra ? Math.min(1, p.extra.current / p.extra.goal) : Math.min(1, p.current / p.goal))) / 2) * 100) : 0;
  return h(
    'div.nx-ach-card',
    { class: won ? 'won' : '' },
    medal(a, won),
    h(
      'div.nx-ach-text',
      {},
      h('div.nx-ach-title', {}, a.title),
      h('div.nx-ach-desc', { class: a.secret && !won ? 'nx-ach-hint' : '' }, a.description),
      h(
        'div.nx-ach-meta',
        {},
        h('span.nx-ach-tier', { class: a.tier }, `${TIER_LABEL[a.tier]} · ${TIER_POINTS[a.tier]} pts`),
        won ? h('span', {}, `✔ ${new Date(a.unlockedAt!).toLocaleDateString('es-ES')}`) : p ? h('span', {}, `${p.current}/${p.goal}${p.extra ? ` · ${p.extra.current}/${p.extra.goal} ${p.extra.label}` : ''}`) : '',
      ),
      !won && p ? h('div.nx-ach-bar', {}, h('span', { class: a.tier, style: `width:${pct}%` })) : '',
    ),
  );
}

function openTrophyRoom() {
  const body = h('div.body.nx-ach-body');
  const render = () => {
    if (!summary) {
      body.replaceChildren(h('p.nx-ach-empty', {}, connected ? 'Cargando…' : 'La vitrina está vacía: arranca la oficina junto a Nexura (npm run start:all) para ver tus logros.'));
      return;
    }
    const pct = summary.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
    const level = Math.floor(summary.points / 100) + 1;
    const groups = (Object.keys(CATEGORY_LABEL) as Category[]).map((c) => [c, summary!.achievements.filter((a) => a.category === c)] as const).filter(([, list]) => list.length);
    body.replaceChildren(
      h(
        'div.nx-ach-hero',
        {},
        h('div.nx-ach-level', {}, h('small', {}, 'Nivel'), h('b', {}, String(level))),
        h(
          'div.nx-ach-stats',
          {},
          h('div', {}, h('b', {}, `${summary.points}`), ` de ${summary.maxPoints} puntos`),
          h('div.nx-ach-bar.big', {}, h('span', { style: `width:${pct}%` })),
          h('div', {}, `${summary.unlocked} de ${summary.total} logros · ${pct} %`, summary.ducks.length ? ` · 🦆 ${summary.ducks.length}/${DUCKS.length}` : ''),
        ),
      ),
      ...groups.flatMap(([c, list]) => [
        h('h3.nx-ach-group', {}, `${CATEGORY_LABEL[c]} `, h('span', {}, `${list.filter((a) => a.unlockedAt).length}/${list.length}`)),
        h('div.nx-ach-grid', {}, ...list.map(card)),
      ]),
    );
  };
  render();
  onChange.add(render);
  const el = h('div.modal.nx-ach-modal', { role: 'dialog', 'aria-label': 'Vitrina de logros' }, h('header', {}, h('h2', {}, '🏆 Vitrina de logros')), body);
  openModal(el, { doing: '🏆 admirando la vitrina', onClose: () => onChange.delete(render) });
  void load();
}

// ---- Toasts ------------------------------------------------------------------------------------------

/** Trophies waiting their turn on screen. */
const queue: Achievement[] = [];

/** A trophy toast, top right, like a console's; Nexura shows its own when it frames the office. */
function showTrophy(a: Achievement) {
  if (window.parent !== window) return;
  queue.push(a);
  if (queue.length === 1) nextTrophy();
}

function nextTrophy() {
  const a = queue[0];
  if (!a) return;
  const box = document.getElementById('nx-ach-toasts') ?? document.body.appendChild(h('div', { id: 'nx-ach-toasts', 'aria-live': 'polite' }));
  const el = h(
    'div.nx-ach-toast',
    { role: 'status' },
    medal(a, true),
    h('div', {}, h('small', {}, '🏆 Has conseguido un trofeo'), h('b', {}, a.title), h('span', { class: a.tier }, `${TIER_LABEL[a.tier]} · +${TIER_POINTS[a.tier]} pts`)),
    h('i', { class: a.tier }),
  );
  box.append(el);
  chime();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => {
      el.remove();
      queue.shift();
      nextTrophy();
    }, 350);
  }, TOAST_MS);
}

/** A short message in the office's own toast spot (top center), in Nexura's words. */
function officeToast(text: string) {
  const el = h('div.toast', {}, text);
  document.getElementById('toasts')?.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

let audio: AudioContext | undefined;
/** A quick rising arpeggio, the same as Nexura's. */
function chime() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const t0 = ctx.currentTime + 0.02;
    [783.99, 1046.5, 1318.51, 1567.98].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const at = t0 + i * 0.07;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.14, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.55);
    });
  } catch {
    // no sound here
  }
}

function injectStyles() {
  if (document.getElementById('nx-ach-css')) return;
  const css = `
#nx-ach-toasts { position: fixed; top: 14px; right: 14px; z-index: 1000; width: min(360px, calc(100vw - 28px)); pointer-events: none; }
.nx-ach-toast { position: relative; overflow: hidden; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(11,15,24,.95); color: #fff; box-shadow: 0 20px 50px -16px rgba(0,0,0,.8); font-family: var(--font); animation: nx-ach-in .55s cubic-bezier(.2,.8,.2,1) both; }
.nx-ach-toast.out { animation: nx-ach-out .35s ease-in both; }
.nx-ach-toast small { display: block; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; opacity: .6; }
.nx-ach-toast b { display: block; font-size: 15px; font-weight: 900; margin: 1px 0; }
.nx-ach-toast span.bronze { color: #f0b27a; } .nx-ach-toast span.silver { color: #dfe6f0; } .nx-ach-toast span.gold { color: #ffd75e; } .nx-ach-toast span.platinum { color: #bfe0ff; }
.nx-ach-toast > div > span { font-size: 12px; font-weight: 800; }
.nx-ach-toast i { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; transform-origin: left; animation: nx-ach-timer ${TOAST_MS}ms linear both; }
.nx-ach-toast i.bronze { background: #d99058; } .nx-ach-toast i.silver { background: #c9d2de; } .nx-ach-toast i.gold { background: #ffc940; } .nx-ach-toast i.platinum { background: #a0c8ff; }
.nx-ach-toast::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 45%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.16), transparent); animation: nx-ach-shine 1.1s .45s ease-out both; }
@keyframes nx-ach-in { from { opacity: 0; transform: translateX(110%); } 70% { opacity: 1; transform: translateX(-6px); } to { transform: none; } }
@keyframes nx-ach-out { to { opacity: 0; transform: translateX(40px); } }
@keyframes nx-ach-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@keyframes nx-ach-shine { from { transform: translateX(-120%) skewX(-20deg); } to { transform: translateX(220%) skewX(-20deg); } }
.nx-ach-medal { flex: none; width: 50px; height: 50px; border-radius: 50%; display: grid; place-items: center; font-size: 22px; border: 3px solid var(--ink, #2b2d42); box-shadow: inset 0 -4px 0 rgba(0,0,0,.18), inset 0 3px 0 rgba(255,255,255,.45); }
.nx-ach-toast .nx-ach-medal { border-color: rgba(255,255,255,.25); }
.nx-ach-medal.bronze { background: radial-gradient(circle at 35% 30%, #f0b27a, #a45a28); }
.nx-ach-medal.silver { background: radial-gradient(circle at 35% 30%, #ffffff, #9da8b8); }
.nx-ach-medal.gold { background: radial-gradient(circle at 35% 30%, #fff1a8, #d19a13); }
.nx-ach-medal.platinum { background: radial-gradient(circle at 35% 30%, #f4fbff, #7fa3d0); }
.nx-ach-medal.locked { filter: grayscale(1); opacity: .45; }
.nx-ach-modal { width: min(880px, 100%); }
.nx-ach-body { display: flex; flex-direction: column; gap: 12px; }
.nx-ach-hero { display: flex; align-items: center; gap: 16px; padding: 14px; border: 3px solid var(--ink); border-radius: 16px; background: #fff; box-shadow: 0 4px 0 var(--ink); }
.nx-ach-level { flex: none; width: 74px; height: 74px; border-radius: 50%; display: grid; place-content: center; text-align: center; background: var(--paper-2); border: 3px solid var(--ink); }
.nx-ach-level small { font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: .1em; opacity: .6; }
.nx-ach-level b { font-size: 28px; font-weight: 900; line-height: 1; }
.nx-ach-stats { flex: 1; display: flex; flex-direction: column; gap: 6px; font-weight: 700; font-size: 13px; }
.nx-ach-stats b { font-size: 22px; font-weight: 900; }
.nx-ach-bar { height: 7px; border-radius: 99px; background: #e9e4dc; overflow: hidden; margin-top: 6px; }
.nx-ach-bar.big { height: 10px; border: 2px solid var(--ink); margin: 0; }
.nx-ach-bar span { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #6f5ee0, #a99cff); }
.nx-ach-bar span.bronze { background: #d99058; } .nx-ach-bar span.silver { background: #aab5c5; } .nx-ach-bar span.gold { background: #f5b82e; } .nx-ach-bar span.platinum { background: #7fb0f0; }
.nx-ach-group { margin: 6px 0 0; font-size: 15px; font-weight: 900; } .nx-ach-group span { opacity: .55; font-weight: 800; }
.nx-ach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.nx-ach-card { display: flex; gap: 12px; padding: 12px; border: 3px solid var(--ink); border-radius: 14px; background: #f4efe7; }
.nx-ach-card.won { background: #fff; box-shadow: 0 3px 0 var(--ink); }
.nx-ach-text { min-width: 0; flex: 1; }
.nx-ach-title { font-weight: 900; font-size: 14px; }
.nx-ach-card:not(.won) .nx-ach-title { opacity: .7; }
.nx-ach-desc { font-size: 12.5px; font-weight: 600; opacity: .8; margin-top: 2px; }
.nx-ach-desc.nx-ach-hint { font-style: italic; }
.nx-ach-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; margin-top: 8px; font-size: 11px; font-weight: 800; opacity: .85; }
.nx-ach-tier { padding: 1px 8px; border-radius: 99px; border: 2px solid var(--ink); }
.nx-ach-tier.bronze { background: #f5c9a0; } .nx-ach-tier.silver { background: #e3e8f0; } .nx-ach-tier.gold { background: #ffe08a; } .nx-ach-tier.platinum { background: #d9ecff; }
.nx-ach-empty { font-weight: 700; text-align: center; padding: 24px; }
@media (prefers-reduced-motion: reduce) { .nx-ach-toast, .nx-ach-toast.out, .nx-ach-toast::after { animation: none; } }
`;
  document.head.append(h('style', { id: 'nx-ach-css' }, css));
}
