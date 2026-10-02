// nexura: a Nexura flow at its desk shows which step it's on and which agent runs it: a cap in the
// agent's color on the bean (Claude orange, Codex green, Copilot purple) and the step's tool floating
// by it: a magnifier while it reads the ticket, a keyboard while it implements, a test tube in QA…
import * as THREE from 'three';
import type { WorkerInfo } from '../../shared/protocol';
import type { Worker } from '../world/character';
import { mesh, textSprite, toon } from '../world/toon';

/** What each step holds up. Unknown (custom) steps get a cog. */
const STEP_PROP: Record<string, string> = {
  classify: '🧭',
  enrich: '🔍',
  plan: '🗺️',
  implement: '⌨️',
  qaCode: '🧪',
  codeReview: '👓',
  review: '👓',
  release: '📦',
  addressReview: '💬',
  prReview: '👁️',
};

const AGENT_CAP: Record<string, string> = { claude: '#d97757', codex: '#10a37f', custom: '#8957e5' };

type Props = { key: string; group: THREE.Group };
const props = new WeakMap<Worker, Props>();
const sprites = new Map<string, THREE.Sprite>();

function prop(icon: string): THREE.Sprite {
  let base = sprites.get(icon);
  if (!base) {
    base = textSprite(icon, { size: 44 });
    base.scale.multiplyScalar(0.75);
    sprites.set(icon, base);
  }
  const s = new THREE.Sprite(base.material);
  s.scale.copy(base.scale);
  return s;
}

/** Puts the step's prop and the agent's cap on a Nexura flow's worker; takes them off anyone else. */
export function nexuraWorkerProps(model: Worker, w: WorkerInfo): void {
  const step = w.external?.step;
  const key = w.external ? `${step ?? ''}|${w.provider ?? ''}|${w.status}` : '';
  const had = props.get(model);
  if (had?.key === key) return;
  had?.group.removeFromParent();
  props.delete(model);
  if (!w.external) return;
  const group = new THREE.Group();
  // A cap on top of the bean, its peak to the front.
  const cap = toon(AGENT_CAP[w.provider ?? ''] ?? '#8d99ae');
  group.add(mesh(new THREE.SphereGeometry(0.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap, 0, 0.82, 0));
  const peak = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 16, 1, false, -Math.PI / 2, Math.PI), cap, 0, 0.83, 0.16);
  peak.scale.set(1.2, 1, 1);
  group.add(peak);
  if (step && w.status !== 'done' && w.status !== 'exited') {
    const s = prop(STEP_PROP[step] ?? '⚙️');
    s.position.set(0.42, 0.72, 0.1);
    group.add(s);
  }
  model.root.add(group);
  props.set(model, { key, group });
}
