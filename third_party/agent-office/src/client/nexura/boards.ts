// nexura: three freestanding boards fed by Nexura's digest. The reviews board, by the stairs, pins the
// PRs of other people waiting for your review (Revisiones). Today's board, by the whiteboard, is the
// day in numbers. The vending machine at the end of the kitchen counter shows the quota left.
import * as THREE from 'three';
import { aside, hintTitle, key } from '../core/hint';
import { h, openModal } from '../ui/dom';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { currentDigest, onDigest, type Digest } from './digest';
import { openNexuraPage } from './external';
import { FONT, fit, panel, type Panel } from './panel';
import { PLACES } from './places';
import { nexuraThing } from './things';
import { wallet } from './wallet';

type Place = { x: number; z: number; rotY: number };

/** A board on two legs, `w` × `hh` meters, its face drawn by `paint`; facing +z before it's turned to `place`. */
function easel(place: Place, w: number, hh: number, id: string, title: string) {
  const g = new THREE.Group();
  const wood = toon('#8d5a3b');
  for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.07, 2.1, 0.07), wood, sx * (w / 2 + 0.04), 1.05, -0.05));
  g.add(mesh(roundedBox(w + 0.12, hh + 0.12, 0.06, 0.02), wood, 0, 0.7 + hh / 2, -0.04));
  const p = panel(w, hh);
  p.mesh.position.set(0, 0.7 + hh / 2, 0);
  g.add(p.mesh);
  const sign = textPlane(title, { size: 36, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.55);
  sign.position.set(0, 0.78 + hh + 0.12, 0.01);
  g.add(sign);
  g.position.set(place.x, 0, place.z);
  g.rotation.y = place.rotY;
  const it: Interactable = { kind: 'nexura', nexura: id, x: place.x + Math.sin(place.rotY) * 1.3, z: place.z + Math.cos(place.rotY) * 1.3, radius: 1.8 };
  g.userData.interact = it;
  const half = w / 2 + 0.1;
  const along = Math.abs(Math.sin(place.rotY)) > 0.5;
  const collider = along ? { minX: place.x - 0.15, maxX: place.x + 0.15, minZ: place.z - half, maxZ: place.z + half, top: 2.1 } : { minX: place.x - half, maxX: place.x + half, minZ: place.z - 0.15, maxZ: place.z + 0.15, top: 2.1 };
  return { group: g, panel: p, it, collider };
}

function paper(g: CanvasRenderingContext2D, w: number, hh: number) {
  g.fillStyle = '#fffaf3';
  g.fillRect(0, 0, w, hh);
}

// ---- PRs to review ---------------------------------------------------------------------------------------

const reviewPanels: Panel[] = [];

function paintReviews(g: CanvasRenderingContext2D, w: number, hh: number, d: Digest | null) {
  paper(g, w, hh);
  const prs = d?.toReview ?? [];
  const pad = w * 0.04;
  g.fillStyle = '#2b2d42';
  if (!prs.length) {
    g.font = `800 ${hh * 0.07}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(d ? 'Nada que revisar 🎉' : 'Sin conexión con Nexura', w / 2, hh / 2);
    g.textAlign = 'left';
    return;
  }
  const row = (hh - pad * 2) / 6;
  prs.slice(0, 6).forEach((pr, i) => {
    const y = pad + i * row;
    g.fillStyle = pr.reviewed ? '#c8f7e4' : ['#ffe69c', '#bde0fe', '#ffc2cf'][i % 3]!;
    g.fillRect(pad, y + 4, w - pad * 2, row - 8);
    g.fillStyle = '#2b2d42';
    g.font = `900 ${row * 0.32}px ${FONT}`;
    g.fillText(fit(g, `${pr.reviewed ? '✓ ' : ''}${pr.repo} #${pr.id}`, w * 0.3), pad * 1.6, y + row * 0.45);
    g.font = `700 ${row * 0.28}px ${FONT}`;
    g.fillText(fit(g, pr.title, w * 0.62), w * 0.34, y + row * 0.45);
    g.fillStyle = '#6c757d';
    g.font = `700 ${row * 0.24}px ${FONT}`;
    g.fillText(`de ${pr.author}`, w * 0.34, y + row * 0.78);
  });
}

export const reviewsFixture: Fixture = () => {
  const e = easel(PLACES.reviews, 2.4, 1.3, 'reviews', '👁️ Por revisar');
  reviewPanels.push(e.panel);
  paintAll();
  return { group: e.group, colliders: [e.collider], interactables: [e.it] };
};

function openReviews() {
  const prs = currentDigest()?.toReview ?? [];
  const body = h(
    'div.body',
    {},
    ...(prs.length
      ? prs.map((pr) => h('div.nx-row', {}, h('b', {}, `${pr.repo} #${pr.id}`), h('span.grow', {}, pr.title), h('span.nx-muted', {}, pr.author), pr.reviewed ? h('span.nx-pill.ok', {}, 'revisada') : '', h('button.btn', { type: 'button', onclick: () => openNexuraPage('reviews', pr.repo) }, 'Revisar en Nexura')))
      : [h('p.nx-locked', {}, 'No hay PR de otras personas esperando tu revisión.')]),
  );
  openModal(h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Por revisar' }, h('header', {}, h('h2', {}, '👁️ PR por revisar')), body), { doing: '👁️ mirando PR por revisar' });
}

nexuraThing('reviews', {
  hint: () => {
    const n = currentDigest()?.toReview.filter((pr) => !pr.reviewed).length ?? 0;
    return { k: `reviews${n}`, parts: [hintTitle('👁️ Por revisar'), aside(n ? `${n} PR esperan tu revisión` : 'nada pendiente'), key('E', 'Ver las PR')] };
  },
  use: (_it, k) => {
    if (k === 'E') openReviews();
  },
});

// ---- Today -----------------------------------------------------------------------------------------------

const todayPanels: Panel[] = [];

function paintToday(g: CanvasRenderingContext2D, w: number, hh: number, d: Digest | null) {
  paper(g, w, hh);
  const t = d?.today;
  g.fillStyle = '#2b2d42';
  g.font = `900 ${hh * 0.1}px ${FONT}`;
  g.fillText(`📅 ${new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`, w * 0.05, hh * 0.15);
  const cells: [string, string][] = t
    ? [
        ['✅', `${t.flowsDone} flujos terminados`],
        ['🔀', `${t.prsOpened} PR abiertas · ${t.prsMerged} integradas`],
        ['👁️', `${t.reviews} revisiones publicadas`],
        ['💸', `$${t.costUsd.toFixed(2)} gastados`],
        ['🪙', `${wallet()?.earnedToday ?? t.coins} monedas ganadas`],
        ['🏆', t.trophies.length ? `${t.trophies.length} logros: ${t.trophies.join(', ')}` : 'Ningún logro nuevo… aún'],
      ]
    : [['🔌', 'Sin conexión con Nexura']];
  g.font = `800 ${hh * 0.075}px ${FONT}`;
  cells.forEach(([icon, text], i) => {
    const y = hh * (0.32 + i * 0.12);
    g.fillText(icon, w * 0.05, y);
    g.fillText(fit(g, text, w * 0.8), w * 0.15, y);
  });
}

export const todayFixture: Fixture = () => {
  const e = easel(PLACES.summary, 1.8, 1.3, 'today', '📅 Hoy en Nexura');
  todayPanels.push(e.panel);
  paintAll();
  return { group: e.group, colliders: [e.collider], interactables: [e.it] };
};

nexuraThing('today', {
  hint: () => ({ k: 'today', parts: [hintTitle('📅 Hoy en Nexura'), aside('el día en números'), key('E', 'Ver las métricas')] }),
  use: (_it, k) => {
    if (k === 'E') openNexuraPage('metrics');
  },
});

// ---- The quota vending machine ----------------------------------------------------------------------------

const vendingPanels: Panel[] = [];

function paintVending(g: CanvasRenderingContext2D, w: number, hh: number, d: Digest | null) {
  g.fillStyle = '#10161f';
  g.fillRect(0, 0, w, hh);
  const quota = d?.quota ?? [];
  g.fillStyle = '#7CFFB2';
  g.font = `900 ${hh * 0.2}px ${FONT}`;
  g.fillText('CUOTA LIBRE', w * 0.04, hh * 0.24);
  if (!quota.length) {
    g.font = `700 ${hh * 0.16}px ${FONT}`;
    g.fillStyle = '#9fb3c8';
    g.fillText(d ? 'Aún sin datos de Claude' : 'Sin conexión con Nexura', w * 0.04, hh * 0.6);
  }
  const cols = Math.max(1, Math.min(2, quota.length));
  quota.slice(0, 2).forEach((q, i) => {
    const x = w * 0.04 + i * (w * 0.94) / cols;
    const bw = (w * 0.94) / cols - w * 0.04;
    const left = Math.max(0, 100 - q.percent);
    g.fillStyle = '#9fb3c8';
    g.font = `800 ${hh * 0.12}px ${FONT}`;
    g.fillText(fit(g, `${q.label.replace('Claude · ', '')} · ${left}%`, bw), x, hh * 0.52);
    g.fillStyle = '#26303f';
    g.fillRect(x, hh * 0.62, bw, hh * 0.22);
    g.fillStyle = left < 15 ? '#ef476f' : left < 40 ? '#ffd166' : '#06d6a0';
    g.fillRect(x, hh * 0.62, bw * (left / 100), hh * 0.22);
  });
}

export const vendingFixture: Fixture = () => {
  const g = new THREE.Group();
  g.add(mesh(roundedBox(0.95, 1.95, 0.8, 0.06), toon('#e63946'), 0, 0.975, 0));
  g.add(mesh(new THREE.BoxGeometry(0.78, 0.86, 0.02), toon('#a8dadc', { transparent: true, opacity: 0.3 }), 0, 1.12, 0.47, false));
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 10), toon(['#ffd166', '#06d6a0', '#4cc9f0', '#ef476f'][(r + c) % 4]!), -0.27 + c * 0.18, 0.84 + r * 0.27, 0.41, false));
  const p = panel(0.8, 0.3, 360);
  p.mesh.position.set(0, 1.76, 0.405);
  g.add(p.mesh);
  vendingPanels.push(p);
  g.add(mesh(new THREE.BoxGeometry(0.62, 0.16, 0.05), toon('#1b1b1b'), 0, 0.42, 0.41, false));
  const sign = textPlane('🥤 Cuota', { size: 34, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.5);
  sign.position.set(0, 2.1, 0.41);
  g.add(sign);
  const { x, z, rotY } = PLACES.vending;
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  const it: Interactable = { kind: 'nexura', nexura: 'vending', x: x + Math.sin(rotY) * 1.1, z: z + Math.cos(rotY) * 1.1, radius: 1.4 };
  g.userData.interact = it;
  paintAll();
  return { group: g, colliders: [{ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.42, maxZ: z + 0.42, top: 1.95 }], interactables: [it] };
};

nexuraThing('vending', {
  hint: () => {
    const q = currentDigest()?.quota[0];
    return { k: `vending${q?.percent}`, parts: [hintTitle('🥤 Máquina de cuota'), aside(q ? `${q.label}: ${Math.max(0, 100 - q.percent)}% libre` : 'sin datos de cuota'), key('E', 'Ver el gasto')] };
  },
  use: (_it, k) => {
    if (k === 'E') openNexuraPage('metrics');
  },
});

function paintAll() {
  const d = currentDigest();
  const key = JSON.stringify(d) + (wallet()?.earnedToday ?? '');
  for (const p of reviewPanels) p.draw(`${key}r`, (g, w, hh) => paintReviews(g, w, hh, d));
  for (const p of todayPanels) p.draw(`${key}t${new Date().toDateString()}`, (g, w, hh) => paintToday(g, w, hh, d));
  for (const p of vendingPanels) p.draw(`${key}v`, (g, w, hh) => paintVending(g, w, hh, d));
}
onDigest(paintAll);
