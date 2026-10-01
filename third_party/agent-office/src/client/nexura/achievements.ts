// nexura: Nexura's trophies in the office (apps/server/src/achievements in Nexura). A glass trophy
// case against the east wall shows the cups you've won and opens the full list; five rubber ducks
// hide around the room; and a few secrets (the Konami code, a visit at night, a hole in one) count
// too. What you do goes to Nexura through the office's server (server/nexura/achievements.ts).
// When the office is framed by Nexura, Nexura shows the trophy toast; on its own, the office does.
import * as THREE from 'three';
import { BALCONY, BOOKSHELF, FLOOR, LOFT } from '../../shared/layout';
import { buildCase, buildDuck, fillCase, squeak, type CaseView, type Tier } from './trophy-case';
import { h, openModal } from '../ui/dom';
import type { Fixture } from '../world/office/fixture';
import type { Collider, Interactable } from '../world/types';

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
const CATEGORY_LABEL: Record<Category, string> = { tickets: 'Tickets', reviews: 'Revisiones', constancy: 'Constancia', office: 'Oficina 3D', legend: 'Leyenda' };
/** What the office's interactables are called by Nexura (its OfficeUse). */
const USES = new Set(['desk', 'station', 'issues', 'pulls', 'services', 'queue', 'tv', 'coffee', 'decor', 'smoke', 'elevator', 'gong', 'dog', 'jukebox', 'seat', 'whiteboard', 'cabinet', 'ladder', 'pole', 'meeting', 'bar', 'dj', 'golf', 'ball', 'bookshelf']);
const POLL_MS = 30_000;
const TOAST_MS = 20_000;
const GOLF_KEY = 'agent-office.golf';
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Where the ducks hide: [x, y, z]. On the bookshelf, by the fridge, behind a plant, on the balcony, and upstairs. */
export const DUCKS: readonly (readonly [number, number, number])[] = [
  [BOOKSHELF.x + 0.55, BOOKSHELF.height + 0.07, BOOKSHELF.z - 0.02],
  [-12.3, 1.03, 12.35],
  [16.45, 0, -12.7],
  [BALCONY.maxX - 0.35, 0, BALCONY.minZ + 0.35], // against the wall: the south-east corner gets a pumpkin at Halloween (world/holiday.ts)
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

const cases: CaseView[] = [];
const ducks: { group: THREE.Group; n: number }[] = [];

function plaqueText(): string {
  return summary ? `🏆 Logros · ${summary.unlocked}/${summary.total}` : '🏆 Logros';
}

/**
 * Nexura's things on an office floor: the trophy case and the ducks. One of the floor's fixtures (see
 * world/office/build.ts); starts talking to Nexura the first time a floor is built.
 */
export const nexuraFixture: Fixture = () => {
  start();
  const group = new THREE.Group();
  const trophyCase = buildCase(plaqueText());
  group.add(trophyCase.group);
  const colliders: Collider[] = [trophyCase.collider];
  const interactables: Interactable[] = [trophyCase.interactable];
  cases.push(trophyCase.view);
  fillCase(trophyCase.view, summary?.achievements ?? [], plaqueText());

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
  return { group, colliders, interactables };
};

onChange.add(() => cases.forEach((view) => fillCase(view, summary?.achievements ?? [], plaqueText())));

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
