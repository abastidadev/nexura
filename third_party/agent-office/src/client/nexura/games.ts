// nexura: the game room, between the pods and the lounge, with the three games of Nexura's shop: the
// futbolín, the trivia cabinet (questions about your repos' history, from git) and the Grand Prix, a
// slot-car track where each flow running is a car that goes round as its steps get done. A game not
// bought yet stands under a tarp; E there opens the shop.
import * as THREE from 'three';
import { aside, hintTitle, key } from '../core/hint';
import { h, openModal } from '../ui/dom';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { openRaceBet } from './bets';
import { currentDigest } from './digest';
import { openFutbolin } from './futbolin';
import { PLACES } from './places';
import { openShop } from './shop';
import { nexuraThing } from './things';
import { loadWallet, lockedText, nexura, onWallet, owns, wallet } from './wallet';

const GAMES = { futbolin: 'game-futbolin', trivia: 'game-trivia', race: 'game-race' } as const;
type Game = keyof typeof GAMES;

const covers: { game: Game; tarp: THREE.Object3D }[] = [];
function lockCovers() {
  for (const c of covers) c.tarp.visible = !owns(GAMES[c.game]);
}
onWallet(lockCovers);

/** A grey tarp over a game not bought yet, with a padlock sign. */
function tarp(w: number, hh: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const cloth = mesh(roundedBox(w, hh, d, 0.08), toon('#8d99ae'), 0, hh / 2, 0);
  g.add(cloth);
  const sign = textPlane('🔒 En la tienda', { size: 30, bg: '#ffe69c' });
  sign.scale.multiplyScalar(0.55);
  sign.position.set(0, hh + 0.2, 0);
  g.add(sign);
  return g;
}

function place(g: THREE.Group, at: { x: number; z: number; rotY: number }, id: string, reach: number): Interactable {
  g.position.set(at.x, 0, at.z);
  g.rotation.y = at.rotY;
  const it: Interactable = { kind: 'nexura', nexura: id, x: at.x + Math.sin(at.rotY) * reach, z: at.z + Math.cos(at.rotY) * reach, radius: 1.6 };
  g.userData.interact = it;
  return it;
}

// ---- The futbolín -----------------------------------------------------------------------------------------

function futbolinTable(): THREE.Group {
  const g = new THREE.Group();
  const wood = toon('#6f4e37');
  g.add(mesh(new THREE.BoxGeometry(1.5, 0.22, 0.85), wood, 0, 0.82, 0));
  g.add(mesh(new THREE.BoxGeometry(1.38, 0.02, 0.73), toon('#2d6a4f'), 0, 0.92, 0, false));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), wood, sx! * 0.68, 0.36, sz! * 0.36));
  // Eight rods across, with their players and handles.
  for (let i = 0; i < 8; i++) {
    const x = -0.6 + i * (1.2 / 7);
    const color = i % 2 ? '#e63946' : '#4361ee';
    g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.15, 6).rotateX(Math.PI / 2), toon('#ced4da'), x, 0.98, 0, false));
    g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8).rotateX(Math.PI / 2), toon('#1b1b1b'), x, 0.98, i % 2 ? 0.6 : -0.6, false));
    const n = [1, 2, 5, 3, 3, 5, 2, 1][i]!;
    for (let k = 0; k < n; k++) g.add(mesh(new THREE.BoxGeometry(0.03, 0.12, 0.05), toon(color), x, 0.96, -0.3 + ((k + 0.5) / n) * 0.6, false));
  }
  return g;
}

export const futbolinFixture: Fixture = () => {
  const g = futbolinTable();
  const lock = tarp(1.6, 1.05, 1.4);
  g.add(lock);
  covers.push({ game: 'futbolin', tarp: lock });
  const it = place(g, PLACES.futbolin, 'futbolin', -1.1);
  const { x, z } = PLACES.futbolin;
  lockCovers();
  return { group: g, colliders: [{ minX: x - 0.8, maxX: x + 0.8, minZ: z - 0.45, maxZ: z + 0.45, top: 1 }], interactables: [it] };
};

// ---- The trivia cabinet --------------------------------------------------------------------------------------

export const triviaFixture: Fixture = () => {
  const g = new THREE.Group();
  const body = toon('#3a0ca3');
  g.add(mesh(roundedBox(0.8, 1.9, 0.75, 0.05), body, 0, 0.95, 0));
  g.add(mesh(new THREE.BoxGeometry(0.62, 0.48, 0.02), toon('#4cc9f0', { emissive: '#1b4965' }), 0, 1.4, 0.38, false));
  g.add(mesh(new THREE.BoxGeometry(0.7, 0.08, 0.3), toon('#7209b7'), 0, 1.02, 0.45));
  for (const [i, c] of ['#ef476f', '#ffd166', '#06d6a0', '#118ab2'].entries()) g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), toon(c), -0.22 + i * 0.15, 1.07, 0.5, false));
  const sign = textPlane('❓ Trivial del repo', { size: 32, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.5);
  sign.position.set(0, 2.05, 0.3);
  g.add(sign);
  const lock = tarp(0.9, 2.0, 1.3);
  g.add(lock);
  covers.push({ game: 'trivia', tarp: lock });
  const it = place(g, PLACES.trivia, 'trivia', 1.1);
  const { x, z } = PLACES.trivia;
  lockCovers();
  return { group: g, colliders: [{ minX: x - 0.42, maxX: x + 0.42, minZ: z - 0.4, maxZ: z + 0.4, top: 1.9 }], interactables: [it] };
};

interface Question {
  id: string;
  repo: string;
  question: string;
  options: string[];
}

function openTrivia() {
  const body = h('div.body');
  let streak = 0;
  const ask = async () => {
    body.replaceChildren(h('p.nx-muted', {}, 'Buscando en la historia de tus repos…'));
    try {
      const q = await nexura<Question>('rewards/trivia');
      const status = h('p.nx-muted', { role: 'status' });
      const buttons = q.options.map((option) => {
        const b = h('button.nx-row', { type: 'button', style: 'cursor:pointer;width:100%;text-align:left' }, h('span.grow', {}, option));
        b.addEventListener('click', async () => {
          buttons.forEach((x) => (x.disabled = true));
          try {
            const a = await nexura<{ correct: boolean; answer: string; coins: number; earnedToday: number }>('rewards/trivia', { id: q.id, option });
            streak = a.correct ? streak + 1 : 0;
            buttons.forEach((x) => {
              const text = x.textContent ?? '';
              if (text === a.answer) x.style.background = '#c8f7e4';
              else if (x === b) x.style.background = '#ffc2cf';
            });
            status.textContent = a.correct ? `✅ ¡Correcto!${a.coins ? ` +${a.coins} 🪙` : ' (hoy el Trivial ya no paga más)'} · racha ${streak}` : `❌ Era «${a.answer}»`;
            void loadWallet();
          } catch (err) {
            status.textContent = `⚠️ ${(err as Error).message}`;
          }
        });
        return b;
      });
      body.replaceChildren(h('div.nx-row', {}, h('span.nx-pill', {}, q.repo), h('span.grow', {}, ''), h('span.nx-pill', {}, `🔥 ${streak}`), h('span.nx-pill', {}, `🪙 ${wallet()?.coins ?? '?'}`)), h('p.nx-big', { style: 'font-size:20px' }, q.question), ...buttons, status, h('div.nx-actions', {}, h('button.btn.primary', { type: 'button', onclick: () => void ask() }, 'Siguiente pregunta ➜')));
    } catch (err) {
      body.replaceChildren(h('p.nx-locked', {}, (err as Error).message));
    }
  };
  void ask();
  openModal(h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Trivial del repo' }, h('header', {}, h('h2', {}, '❓ Trivial del repo')), body), { doing: '❓ jugando al Trivial' });
}

// ---- The Grand Prix ----------------------------------------------------------------------------------------

const TRACK = { rx: 0.62, rz: 0.34 };
type Car = { mesh: THREE.Group; lap: number };
const tracks: { cars: Map<string, Car>; group: THREE.Group }[] = [];
const CAR_COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#4cc9f0', '#b5179e', '#f77f00'];

/** How far round a flow is: its steps done out of all of them, 0 to 1. */
function progress(runId: string): number {
  const flow = currentDigest()?.active.find((f) => f.runId === runId);
  if (!flow?.steps.length) return 0;
  return flow.steps.filter((s) => s.status === 'succeeded' || s.status === 'skipped').length / flow.steps.length;
}

function car(color: string): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.12, 0.04, 0.06), toon(color), 0, 0.025, 0, false));
  g.add(mesh(new THREE.BoxGeometry(0.05, 0.03, 0.05), toon('#1b1b1b'), -0.01, 0.055, 0, false));
  return g;
}

export const raceFixture: Fixture = () => {
  const g = new THREE.Group();
  g.add(mesh(roundedBox(1.7, 0.08, 1.05, 0.03), toon('#2b2d42'), 0, 0.82, 0));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(mesh(new THREE.BoxGeometry(0.07, 0.8, 0.07), toon('#2b2d42'), sx! * 0.76, 0.4, sz! * 0.44));
  g.add(mesh(new THREE.RingGeometry(0.98, 1.12, 48).rotateX(-Math.PI / 2).scale(TRACK.rx, 1, TRACK.rz), toon('#495057'), 0, 0.865, 0, false));
  g.add(mesh(new THREE.PlaneGeometry(0.04, 0.1).rotateX(-Math.PI / 2), toon('#f8f9fa'), TRACK.rx * 1.05, 0.87, 0, false));
  const sign = textPlane('🏎️ Gran Premio', { size: 32, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.5);
  sign.position.set(0, 1.3, -0.5);
  g.add(sign);
  const cars = new Map<string, Car>();
  const carsGroup = new THREE.Group();
  carsGroup.position.y = 0.87;
  g.add(carsGroup);
  tracks.push({ cars, group: carsGroup });
  const lock = tarp(1.8, 1.0, 1.15);
  g.add(lock);
  covers.push({ game: 'race', tarp: lock });
  const it = place(g, PLACES.race, 'race', 1.1);
  const { x, z } = PLACES.race;
  lockCovers();
  return {
    group: g,
    colliders: [{ minX: x - 0.85, maxX: x + 0.85, minZ: z - 0.53, maxZ: z + 0.53, top: 1 }],
    interactables: [it],
    update(_t: number, dt: number) {
      const flows = currentDigest()?.active ?? [];
      for (const track of tracks) {
        flows.forEach((f, i) => {
          let c = track.cars.get(f.runId);
          if (!c) {
            c = { mesh: car(CAR_COLORS[i % CAR_COLORS.length]!), lap: 0 };
            track.cars.set(f.runId, c);
            track.group.add(c.mesh);
          }
          // Round the track to where its flow has got to, a lane each.
          const target = progress(f.runId);
          c.lap += Math.max(-0.5, Math.min(0.5, target - c.lap)) * Math.min(1, dt * 1.5);
          const a = c.lap * Math.PI * 2;
          const lane = 1.0 + (i % 3) * 0.05;
          c.mesh.position.set(Math.cos(a) * TRACK.rx * lane, 0, Math.sin(a) * TRACK.rz * lane);
          c.mesh.rotation.y = -a - Math.PI / 2;
        });
        for (const [id, c] of track.cars) {
          if (flows.some((f) => f.runId === id)) continue;
          track.group.remove(c.mesh);
          track.cars.delete(id);
        }
      }
    },
  };
};

// ---- Using them ----------------------------------------------------------------------------------------------

const NAMES: Record<Game, string> = { futbolin: '⚽ Futbolín', trivia: '❓ Trivial del repo', race: '🏎️ Gran Premio' };
const PLAY: Record<Game, () => void> = { futbolin: openFutbolin, trivia: openTrivia, race: () => openRaceBet() };
const ABOUT: Record<Game, () => string> = {
  futbolin: () => 'contra la máquina o a dos jugadores',
  trivia: () => 'preguntas sobre la historia de tus repos',
  race: () => `${currentDigest()?.active.length ?? 0} flujos en pista`,
};

for (const game of Object.keys(GAMES) as Game[]) {
  nexuraThing(game, {
    hint: () =>
      owns(GAMES[game])
        ? { k: `${game}${ABOUT[game]()}`, parts: [hintTitle(NAMES[game]), aside(ABOUT[game]()), key('E', game === 'race' ? 'Apostar' : 'Jugar')] }
        : { k: `${game}-locked`, parts: [hintTitle(NAMES[game]), aside(lockedText(GAMES[game])), key('E', 'Ir a la tienda')] },
    use: (_it, k) => {
      if (k !== 'E') return;
      if (owns(GAMES[game])) PLAY[game]();
      else openShop();
    },
  });
}

/** The game room's rug and its sign, under the three games. */
export const gameRoomFixture: Fixture = () => {
  const g = new THREE.Group();
  const room = PLACES.gameRoom;
  const rug = mesh(new THREE.PlaneGeometry(room.width, room.depth).rotateX(-Math.PI / 2), toon('#5a189a', { opacity: 0.35 }), room.x, 0.012, room.z, false);
  rug.receiveShadow = true;
  g.add(rug);
  const sign = textPlane('🎮 Sala de juegos', { size: 40, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.6);
  sign.position.set(room.x, 2.7, room.z - room.depth / 2 - 0.05);
  g.add(sign);
  return { group: g };
};

/** Opens the game in the window: for the palette. */
export function playGame(game: Game): void {
  if (owns(GAMES[game])) PLAY[game]();
  else openShop();
}
