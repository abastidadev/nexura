// nexura: the control room. A wall of three monitors in the west aisle shows Nexura's flows running:
// each one's pipeline step by step, the agent on it, what it has cost and whether it waits for you.
// More than three take turns. E lists them all, to open one or approve the ones waiting.
import * as THREE from 'three';
import { boxFootprint } from '../../shared/maps/props';
import { aside, hintTitle, key } from '../core/hint';
import { h, openModal } from '../ui/dom';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { openApproveFlow } from './desk';
import { openPorra } from './bets';
import { currentDigest, onDigest, type DigestFlow } from './digest';
import { openNexuraPage, openNexuraRunId } from './external';
import { FONT, fit, panel, type Panel } from './panel';
import { PLACES } from './places';
import { nexuraThing } from './things';

const SCREENS = 3;
const SCREEN = { w: 1.5, h: 0.95 };
const STATUS_COLOR: Record<string, string> = { succeeded: '#06d6a0', running: '#4cc9f0', failed: '#ef476f', pending: '#3d405b', skipped: '#8d99ae' };
const AGENT_COLOR: Record<string, string> = { claude: '#d97757', codex: '#10a37f', copilot: '#8957e5' };

const walls: Panel[][] = [];
let page = 0;

function paintFlow(g: CanvasRenderingContext2D, w: number, hgt: number, flow: DigestFlow | undefined, n: number, of: number) {
  g.fillStyle = '#0b1320';
  g.fillRect(0, 0, w, hgt);
  if (!flow) {
    g.fillStyle = '#3d4a63';
    g.font = `800 ${hgt * 0.09}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(of ? '—' : 'Sin flujos en marcha', w / 2, hgt / 2);
    g.font = `700 ${hgt * 0.055}px ${FONT}`;
    if (!of) g.fillText('Lanza uno en Nexura y aparece aquí', w / 2, hgt / 2 + hgt * 0.1);
    return;
  }
  const pad = w * 0.05;
  g.textAlign = 'left';
  g.fillStyle = AGENT_COLOR[flow.agent] ?? '#8d99ae';
  g.fillRect(0, 0, w, hgt * 0.035);
  g.fillStyle = '#ffffff';
  g.font = `900 ${hgt * 0.12}px ${FONT}`;
  g.fillText(flow.name, pad, hgt * 0.19);
  g.fillStyle = '#9fb3c8';
  g.font = `700 ${hgt * 0.065}px ${FONT}`;
  g.fillText(fit(g, flow.title, w - pad * 2), pad, hgt * 0.3);
  // The pipeline: a box per step, left to right.
  const steps = flow.steps.length ? flow.steps : [{ step: '…', status: 'pending' as const }];
  const gap = w * 0.012;
  const bw = (w - pad * 2 - gap * (steps.length - 1)) / steps.length;
  steps.forEach((s, i) => {
    const x = pad + i * (bw + gap);
    g.fillStyle = STATUS_COLOR[s.status] ?? '#3d405b';
    g.globalAlpha = s.status === 'pending' ? 0.6 : 1;
    g.fillRect(x, hgt * 0.4, bw, hgt * 0.17);
    g.globalAlpha = 1;
    g.fillStyle = s.status === 'pending' ? '#c9d6e8' : '#0b1320';
    g.font = `800 ${Math.min(hgt * 0.055, bw * 0.16)}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(fit(g, s.step, bw - 6), x + bw / 2, hgt * 0.505);
    g.textAlign = 'left';
  });
  g.fillStyle = '#ffffff';
  g.font = `800 ${hgt * 0.07}px ${FONT}`;
  g.fillText(`${flow.current ? `▶ ${flow.current}` : flow.status} · ${flow.agent}`, pad, hgt * 0.7);
  g.fillStyle = '#ffd166';
  g.textAlign = 'right';
  g.fillText(`$${flow.costUsd.toFixed(2)}`, w - pad, hgt * 0.7);
  g.textAlign = 'left';
  if (flow.waiting) {
    g.fillStyle = '#ffd166';
    g.fillRect(pad, hgt * 0.78, w - pad * 2, hgt * 0.13);
    g.fillStyle = '#0b1320';
    g.font = `900 ${hgt * 0.07}px ${FONT}`;
    g.fillText(flow.waiting === 'pr' ? '✋ Espera que apruebes la PR' : flow.waiting === 'replies' ? '✋ Respuestas listas para publicar' : '✋ Espera tu visto bueno', pad * 1.4, hgt * 0.87);
  }
  if (of > SCREENS) {
    g.fillStyle = '#5c6b85';
    g.font = `700 ${hgt * 0.05}px ${FONT}`;
    g.textAlign = 'right';
    g.fillText(`${n + 1}/${of}`, w - pad, hgt * 0.97);
  }
}

function paint() {
  const flows = currentDigest()?.active ?? [];
  const pages = Math.max(1, Math.ceil(flows.length / SCREENS));
  const first = (page % pages) * SCREENS;
  for (const screens of walls) {
    screens.forEach((p, i) => {
      const flow = flows[first + i];
      p.draw(JSON.stringify([flow, first + i, flows.length]), (g, w, hh) => paintFlow(g, w, hh, flow, first + i, flows.length));
    });
  }
}
onDigest(paint);
setInterval(() => {
  page++;
  paint();
}, 7000);

export const controlRoomFixture: Fixture = () => {
  const g = new THREE.Group();
  const frame = toon('#2b2d42');
  const width = SCREENS * (SCREEN.w + 0.1) + 0.1;
  // A long desk in front, and the stand the screens hang on.
  g.add(mesh(roundedBox(width, 0.08, 0.7, 0.03), toon('#e9ecef'), 0, 0.76, 0.75));
  for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.06, 0.76, 0.6), frame, sx * (width / 2 - 0.1), 0.38, 0.75));
  g.add(mesh(new THREE.BoxGeometry(width, 1.25, 0.12), frame, 0, 1.75, 0));
  for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.12, 1.2, 0.12), frame, sx * (width / 2 - 0.15), 0.6, 0));
  const screens: Panel[] = [];
  for (let i = 0; i < SCREENS; i++) {
    const p = panel(SCREEN.w, SCREEN.h);
    p.mesh.position.set(-width / 2 + 0.1 + SCREEN.w / 2 + i * (SCREEN.w + 0.1), 1.75, 0.065);
    g.add(p.mesh);
    screens.push(p);
  }
  walls.push(screens);
  const sign = textPlane('🛰️ Sala de control', { size: 40, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.62);
  sign.position.set(0, 2.62, 0.07);
  g.add(sign);
  const { x, z, rotY } = PLACES.control;
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  paint();
  const it: Interactable = { kind: 'nexura', nexura: 'control', x: x + Math.sin(rotY) * 1.6, z: z + Math.cos(rotY) * 1.6, radius: 2.4 };
  g.userData.interact = it;
  // The screens' stand and the desk in front of them, turned the way it faces.
  const [minX, maxX, minZ, maxZ] = boxFootprint(x + Math.sin(rotY) * 0.5, z + Math.cos(rotY) * 0.5, width, 1.3, rotY);
  return { group: g, colliders: [{ minX, maxX, minZ, maxZ, top: 2.4 }], interactables: [it] };
};

function openControl() {
  const body = h('div.body');
  const render = () => {
    const flows = currentDigest()?.active ?? [];
    body.replaceChildren(
      ...(flows.length
        ? flows.map((f) =>
            h(
              'div.nx-row',
              {},
              h('b', {}, f.name),
              h('span.grow', {}, f.title),
              h('span.nx-pill', { class: f.waiting ? 'wait' : 'run' }, f.waiting ? '✋ espera' : (f.current ?? f.status)),
              h('span.nx-pill', {}, `$${f.costUsd.toFixed(2)}`),
              f.waiting ? h('button.btn.primary', { type: 'button', onclick: () => openApproveFlow(f, () => openNexuraRunId(f.runId)) }, 'Aprobar…') : '',
              h('button.btn', { type: 'button', onclick: () => openPorra(f) }, '🎲'),
              h('button.btn', { type: 'button', onclick: () => openNexuraRunId(f.runId) }, 'Abrir'),
            ),
          )
        : [h('p.nx-locked', {}, 'No hay flujos en marcha ahora mismo.')]),
      h('div.nx-actions', {}, h('button.btn', { type: 'button', onclick: () => openNexuraPage('runs') }, '↗ Todos los flujos en Nexura')),
    );
  };
  render();
  const off = onDigest(render);
  openModal(h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Sala de control' }, h('header', {}, h('h2', {}, '🛰️ Sala de control')), body), { doing: '🛰️ en la sala de control', onClose: off });
}

nexuraThing('control', {
  hint: () => {
    const flows = currentDigest()?.active ?? [];
    const waiting = flows.filter((f) => f.waiting).length;
    return { k: `control${flows.length}${waiting}`, parts: [hintTitle('🛰️ Sala de control'), aside(`${flows.length} en marcha${waiting ? ` · ${waiting} te esperan` : ''}`), key('E', 'Ver los flujos')] };
  },
  use: (_it, k) => {
    if (k === 'E') openControl();
  },
});
