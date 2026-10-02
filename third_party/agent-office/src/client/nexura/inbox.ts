// nexura: Nexura's mailbox, by the Issues board. Drop an issue card you're carrying in it and Nexura's
// New flow opens with that issue and this floor's repo filled in; the card goes back on the board.
import * as THREE from 'three';
import type { CarriedIssue } from '../../shared/protocol';
import { aside, hintTitle, key } from '../core/hint';
import { store } from '../state';
import { toast } from '../ui/dom';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import type { Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { canStartFlows, startNexuraFlow } from './external';
import { PLACES } from './places';
import { nexuraThing } from './things';

export const inboxFixture: Fixture = () => {
  const g = new THREE.Group();
  const blue = toon('#3a86ff');
  g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10), toon('#2b2d42'), 0, 0.5, 0));
  g.add(mesh(roundedBox(0.55, 0.42, 0.75, 0.12), blue, 0, 1.2, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.75, 20, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), blue, 0, 1.4, 0));
  g.add(mesh(new THREE.BoxGeometry(0.3, 0.03, 0.02), toon('#1b1b1b'), 0, 1.3, 0.38, false));
  const flag = mesh(new THREE.BoxGeometry(0.03, 0.3, 0.16), toon('#ef476f'), 0.3, 1.45, -0.1);
  g.add(flag);
  const sign = textPlane('📮 Buzón de Nexura', { size: 34, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.6);
  sign.position.set(0, 1.85, 0.2);
  g.add(sign);
  const { x, z, rotY } = PLACES.inbox;
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  const it: Interactable = { kind: 'nexura', nexura: 'inbox', x: x + Math.sin(rotY) * 0.9, z: z + Math.cos(rotY) * 0.9, radius: 1.3 };
  g.userData.interact = it;
  return { group: g, colliders: [{ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.4, maxZ: z + 0.4, top: 1.6 }], interactables: [it] };
};

/** A card dropped in the mailbox: the issue goes to Nexura's New flow, the card back on the board. */
export function nexuraDropCard(it: Interactable, card: CarriedIssue, putBack: () => void): boolean {
  if (it.nexura !== 'inbox') return false;
  const project = store.project;
  if (!project || !canStartFlows()) {
    toast('📮 El buzón necesita Nexura: arranca la oficina con npm run start:all', 'warn');
    return true;
  }
  putBack();
  startNexuraFlow(card.issue, project);
  toast(`📮 #${card.issue} va a Nexura: elige allí el perfil y el modelo`);
  return true;
}

nexuraThing('inbox', {
  hint: () => ({ k: 'inbox', parts: [hintTitle('📮 Buzón de Nexura'), aside('suelta aquí una tarjeta del tablero de Issues'), key('E', 'Cómo funciona')] }),
  use: (_it, k) => {
    if (k === 'E') toast('📮 Coge una tarjeta del tablero de Issues (E en ella) y suéltala en el buzón: Nexura abre un flujo nuevo con ella.');
  },
});
