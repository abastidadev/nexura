// nexura: the Hall of Fame, a room of the shop. A gallery wall in the west aisle hangs a framed picture
// of each PR your flows got merged, newest first. Until it's bought from Nexura's shop, a velvet rope
// keeps you out and the frames stay covered.
import * as THREE from 'three';
import { aside, hintTitle, key } from '../core/hint';
import { h, openModal } from '../ui/dom';
import { mesh, textPlane, toon } from '../world/toon';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { currentDigest, onDigest, type Digest } from './digest';
import { openNexuraPage } from './external';
import { FONT, fit, panel, type Panel } from './panel';
import { PLACES } from './places';
import { nexuraThing } from './things';
import { lockedText, onWallet, owns } from './wallet';
import { openShop } from './shop';

const ITEM = 'room-hall-of-fame';
const COLS = 4;
const ROWS = 2;
const FRAME = { w: 1.05, h: 0.72 };
const FRAME_COLORS = ['#c9a227', '#8d5a3b', '#2b2d42', '#b23a48'];
const AGENT_COLOR: Record<string, string> = { claude: '#d97757', codex: '#10a37f', copilot: '#8957e5' };

type Gallery = { frames: Panel[]; rope: THREE.Object3D; lock: THREE.Object3D };
const galleries: Gallery[] = [];

function paintFrame(g: CanvasRenderingContext2D, w: number, hh: number, merge: Digest['merged'][number] | undefined, open: boolean, i: number) {
  if (!open) {
    g.fillStyle = '#d6ccc2';
    g.fillRect(0, 0, w, hh);
    g.fillStyle = '#b8ab9c';
    g.font = `900 ${hh * 0.45}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('?', w / 2, hh * 0.68);
    return;
  }
  // A little painting: a sky in the agent's colors and the PR's title on a plaque.
  const color = AGENT_COLOR[merge?.agents[0] ?? ''] ?? '#4cc9f0';
  const sky = g.createLinearGradient(0, 0, 0, hh);
  sky.addColorStop(0, merge ? color : '#e9ecef');
  sky.addColorStop(1, merge ? '#fff3b0' : '#dee2e6');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, hh);
  g.textAlign = 'center';
  if (!merge) {
    g.fillStyle = '#adb5bd';
    g.font = `800 ${hh * 0.075}px ${FONT}`;
    if (i === 0) {
      g.fillText('Aquí colgará', w / 2, hh * 0.45);
      g.fillText('tu primera PR integrada', w / 2, hh * 0.56);
    }
    return;
  }
  g.font = `${hh * 0.3}px ${FONT}`;
  g.fillText(['🏆', '🚀', '🌟', '🎉', '🦄', '🔥'][i % 6]!, w / 2, hh * 0.45);
  g.fillStyle = 'rgba(255,250,243,.92)';
  g.fillRect(w * 0.06, hh * 0.58, w * 0.88, hh * 0.36);
  g.fillStyle = '#2b2d42';
  g.font = `900 ${hh * 0.1}px ${FONT}`;
  g.fillText(fit(g, merge.name, w * 0.8), w / 2, hh * 0.7);
  g.font = `700 ${hh * 0.075}px ${FONT}`;
  g.fillText(fit(g, merge.title, w * 0.82), w / 2, hh * 0.8);
  g.fillStyle = '#6c757d';
  g.fillText(new Date(merge.mergedAt).toLocaleDateString('es-ES'), w / 2, hh * 0.9);
}

function paint() {
  const open = owns(ITEM);
  const merged = currentDigest()?.merged ?? [];
  for (const gallery of galleries) {
    gallery.rope.visible = !open;
    gallery.lock.visible = !open;
    gallery.frames.forEach((p, i) => p.draw(`${open}|${JSON.stringify(merged[i])}|${i}`, (g, w, hh) => paintFrame(g, w, hh, merged[i], open, i)));
  }
}
onDigest(paint);
onWallet(paint);

export const fameFixture: Fixture = () => {
  const { x, z, rotY, length } = PLACES.fame;
  const g = new THREE.Group();
  // The wall: a long panel with a dark top rail, on low feet.
  g.add(mesh(new THREE.BoxGeometry(length, 2.5, 0.16), toon('#f1e3d3'), 0, 1.25, 0));
  g.add(mesh(new THREE.BoxGeometry(length + 0.1, 0.1, 0.22), toon('#5c3d2e'), 0, 2.52, 0));
  const frames: Panel[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const fx = -length / 2 + (c + 0.5) * (length / COLS);
      const fy = 1.75 - r * 0.95;
      const border = mesh(new THREE.BoxGeometry(FRAME.w + 0.1, FRAME.h + 0.1, 0.05), toon(FRAME_COLORS[(r * COLS + c) % FRAME_COLORS.length]!), fx, fy, 0.1);
      g.add(border);
      const p = panel(FRAME.w, FRAME.h, 260);
      p.mesh.position.set(fx, fy, 0.13);
      g.add(p.mesh);
      frames.push(p);
    }
  }
  const sign = textPlane('🖼️ Galería de la fama', { size: 40, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.6);
  sign.position.set(0, 2.82, 0.05);
  g.add(sign);
  // Locked: a velvet rope on brass posts in front, and a sign on it.
  const rope = new THREE.Group();
  const brass = toon('#c9a227');
  const posts = [-length / 2 + 0.2, 0, length / 2 - 0.2];
  for (const px of posts) {
    rope.add(mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.95, 10), brass, px, 0.475, 1.1));
    rope.add(mesh(new THREE.SphereGeometry(0.07, 10, 8), brass, px, 0.97, 1.1, false));
  }
  for (let i = 0; i < posts.length - 1; i++) {
    const a = new THREE.Vector3(posts[i]!, 0.9, 1.1);
    const b = new THREE.Vector3(posts[i + 1]!, 0.9, 1.1);
    const mid = a.clone().lerp(b, 0.5).setY(0.72);
    rope.add(mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 16, 0.025, 6), toon('#9d0208'), 0, 0, 0, false));
  }
  g.add(rope);
  const lock = textPlane('🔒 En la tienda de Nexura', { size: 30, bg: '#ffe69c' });
  lock.scale.multiplyScalar(0.55);
  lock.position.set(0, 0.62, 1.12);
  g.add(lock);
  galleries.push({ frames, rope, lock });
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  paint();
  const it: Interactable = { kind: 'nexura', nexura: 'fame', x: x + Math.sin(rotY) * 1.6, z: z + Math.cos(rotY) * 1.6, radius: 2.6 };
  g.userData.interact = it;
  return { group: g, colliders: [{ minX: x - 0.12, maxX: x + 0.12, minZ: z - length / 2, maxZ: z + length / 2, top: 2.6 }], interactables: [it] };
};

function openFame() {
  const merged = currentDigest()?.merged ?? [];
  const body = h(
    'div.body',
    {},
    ...(merged.length
      ? merged.map((m) => h('div.nx-row', {}, h('b', {}, m.name), h('span.grow', {}, m.title), h('span.nx-muted', {}, new Date(m.mergedAt).toLocaleDateString('es-ES')), m.url ? h('a.btn', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, 'PR ↗') : ''))
      : [h('p.nx-locked', {}, 'Todavía no hay PR integradas de tus flujos. La primera tendrá aquí su cuadro.')]),
    h('div.nx-actions', {}, h('button.btn', { type: 'button', onclick: () => openNexuraPage('runs') }, '↗ Ver los flujos en Nexura')),
  );
  openModal(h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Galería de la fama' }, h('header', {}, h('h2', {}, '🖼️ Galería de la fama')), body), { doing: '🖼️ en la Galería de la fama' });
}

nexuraThing('fame', {
  hint: () => {
    if (!owns(ITEM)) return { k: 'fame-locked', parts: [hintTitle('🖼️ Galería de la fama'), aside(lockedText(ITEM)), key('E', 'Ir a la tienda')] };
    const n = currentDigest()?.merged.length ?? 0;
    return { k: `fame${n}`, parts: [hintTitle('🖼️ Galería de la fama'), aside(`${n} PR integradas`), key('E', 'Ver la galería')] };
  },
  use: (_it, k) => {
    if (k !== 'E') return;
    if (owns(ITEM)) openFame();
    else openShop();
  },
});
