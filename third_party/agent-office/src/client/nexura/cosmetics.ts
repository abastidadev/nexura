// nexura: what Nexura's shop sells for your character, built in 3D and worn by whoever has it on
// (PeerInfo.nexura): a hat or a complement on the person, a pet that trots after them, a trail left
// as they walk, and a badge by their name tag. Built from the same toon pieces as the office.
import * as THREE from 'three';
import type { Person } from '../world/character';
import { disposeSprite, mesh, textSprite, toon } from '../world/toon';
import { outfitKey, type NexuraOutfit } from '../../shared/nexura-outfit';
import { bodyFit } from './body';

/** Person keeps its head, body and name tag to itself; the shop's things hang on them. */
type PersonParts = { head: THREE.Group; body: THREE.Group; label: THREE.Sprite | null; hat: THREE.Object3D[] };
const partsOf = (p: Person) => p as unknown as PersonParts;

const glow = (color: string) => toon(color, { emissive: color });

// ---- Hats (on the head: a ball of radius 0.34 at its origin) ------------------------------------------

function brim(r: number, color: string, y: number): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(r, r, 0.03, 28), toon(color), 0, y, 0);
}

const HATS: Record<string, () => THREE.Object3D> = {
  'hat-cap': () => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.SphereGeometry(0.355, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon('#e63946'), 0, 0.06, 0));
    const peak = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20, 1, false, -Math.PI / 2, Math.PI), toon('#e63946'), 0, 0.07, 0.27);
    peak.scale.set(1.3, 1, 1);
    g.add(peak);
    return g;
  },
  'hat-beanie': () => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon('#2a9d8f'), 0, 0.04, 0));
    g.add(mesh(new THREE.TorusGeometry(0.34, 0.05, 8, 24).rotateX(Math.PI / 2), toon('#e9c46a'), 0, 0.06, 0));
    g.add(mesh(new THREE.SphereGeometry(0.09, 10, 8), toon('#e9c46a'), 0, 0.42, 0));
    return g;
  },
  'hat-headphones': () => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.TorusGeometry(0.37, 0.035, 8, 24, Math.PI), toon('#2b2d42'), 0, 0.02, 0));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 16).rotateZ(Math.PI / 2), toon('#ef476f'), sx * 0.36, 0, 0));
    return g;
  },
  'hat-chef': () => {
    const g = new THREE.Group();
    const white = toon('#fbfbfb');
    g.add(mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.3, 20), white, 0, 0.4, 0));
    for (const [x, z] of [[0, 0], [0.13, 0.08], [-0.13, 0.08], [0, -0.13]]) g.add(mesh(new THREE.SphereGeometry(0.18, 12, 10), white, x!, 0.6, z!));
    return g;
  },
  'hat-cowboy': () => {
    const g = new THREE.Group();
    g.add(brim(0.56, '#8d5524', 0.24));
    g.add(mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.28, 18), toon('#8d5524'), 0, 0.38, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.285, 0.285, 0.05, 18), toon('#3d2a1f'), 0, 0.27, 0));
    return g;
  },
  'hat-tophat': () => {
    const g = new THREE.Group();
    g.add(brim(0.44, '#1b1b1b', 0.26));
    g.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 20), toon('#1b1b1b'), 0, 0.52, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.265, 0.265, 0.08, 20), toon('#d62828'), 0, 0.32, 0));
    return g;
  },
  'hat-viking': () => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.SphereGeometry(0.37, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon('#8d99ae'), 0, 0.04, 0));
    for (const sx of [-1, 1]) {
      const horn = mesh(new THREE.ConeGeometry(0.08, 0.36, 10), toon('#fff3d6'), sx * 0.4, 0.26, 0);
      horn.rotation.z = -sx * 0.7;
      g.add(horn);
    }
    return g;
  },
  'hat-wizard': () => {
    const g = new THREE.Group();
    g.add(brim(0.48, '#3a0ca3', 0.24));
    const cone = mesh(new THREE.ConeGeometry(0.3, 0.75, 20), toon('#3a0ca3'), 0, 0.62, 0);
    cone.rotation.z = 0.15;
    g.add(cone);
    g.add(mesh(new THREE.OctahedronGeometry(0.06), glow('#ffd60a'), 0.05, 0.6, 0.22, false));
    return g;
  },
  'hat-crown': () => {
    const g = new THREE.Group();
    const gold = toon('#ffc940', { emissive: '#7a5c00' });
    g.add(mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.14, 24, 1, true), gold, 0, 0.33, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.add(mesh(new THREE.ConeGeometry(0.05, 0.14, 8), gold, Math.sin(a) * 0.27, 0.46, Math.cos(a) * 0.27));
      if (i % 2 === 0) g.add(mesh(new THREE.OctahedronGeometry(0.035), glow(i % 4 === 0 ? '#e63946' : '#4cc9f0'), Math.sin(a) * 0.28, 0.33, Math.cos(a) * 0.28, false));
    }
    return g;
  },
  'hat-halo': () => mesh(new THREE.TorusGeometry(0.26, 0.035, 10, 32).rotateX(Math.PI / 2), glow('#fff3b0'), 0, 0.62, 0, false),
};

// ---- Complements (on the head, or on the body: torso at y 0.72, head at 1.32) -------------------------

const ACCESSORIES: Record<string, () => { on: 'head' | 'body'; obj: THREE.Object3D }> = {
  'acc-sunglasses': () => {
    const g = new THREE.Group();
    const dark = toon('#111111');
    for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.15, 0.09, 0.03), dark, sx * 0.12, 0.04, 0.32, false));
    g.add(mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), dark, 0, 0.06, 0.33, false));
    return { on: 'head', obj: g };
  },
  'acc-bowtie': () => {
    const g = new THREE.Group();
    const red = toon('#d62828');
    for (const sx of [-1, 1]) {
      const wing = mesh(new THREE.ConeGeometry(0.06, 0.12, 4), red, sx * 0.06, 1.02, 0.25, false);
      wing.rotation.z = (sx * Math.PI) / 2;
      g.add(wing);
    }
    g.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), red, 0, 1.02, 0.27, false));
    return { on: 'body', obj: g };
  },
  'acc-scarf': () => {
    const g = new THREE.Group();
    const wool = toon('#f4a261');
    g.add(mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 20).rotateX(Math.PI / 2), wool, 0, 1.0, 0));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.32, 0.05), wool, 0.12, 0.84, 0.24));
    return { on: 'body', obj: g };
  },
  'acc-cape': () => {
    const cape = mesh(new THREE.BoxGeometry(0.58, 0.7, 0.03), toon('#c1121f'), 0, 0.68, -0.3);
    cape.rotation.x = 0.12;
    return { on: 'body', obj: cape };
  },
  'acc-jetpack': () => {
    const g = new THREE.Group();
    for (const sx of [-1, 1]) {
      g.add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.42, 14), toon('#adb5bd'), sx * 0.11, 0.75, -0.33));
      g.add(mesh(new THREE.ConeGeometry(0.08, 0.16, 12).rotateX(Math.PI), glow('#ff9f1c'), sx * 0.11, 0.46, -0.33, false));
    }
    return { on: 'body', obj: g };
  },
};

// ---- Pets (in the scene, trotting after their owner) -----------------------------------------------------

const PETS: Record<string, () => THREE.Group> = {
  'pet-duckling': () => {
    const g = new THREE.Group();
    const yellow = toon('#ffd60a');
    const body = mesh(new THREE.SphereGeometry(0.14, 14, 10), yellow, 0, 0.13, 0);
    body.scale.set(1, 0.8, 1.25);
    g.add(body);
    g.add(mesh(new THREE.SphereGeometry(0.09, 12, 10), yellow, 0, 0.3, 0.1));
    g.add(mesh(new THREE.ConeGeometry(0.035, 0.08, 8).rotateX(Math.PI / 2), toon('#f77f00'), 0, 0.29, 0.21, false));
    return g;
  },
  'pet-cat': () => {
    const g = new THREE.Group();
    const fur = toon('#f4a261');
    const body = mesh(new THREE.CapsuleGeometry(0.1, 0.22, 4, 10).rotateX(Math.PI / 2), fur, 0, 0.16, 0);
    g.add(body);
    g.add(mesh(new THREE.SphereGeometry(0.11, 12, 10), fur, 0, 0.3, 0.18));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.04, 0.08, 6), fur, sx * 0.06, 0.42, 0.17));
    const tail = mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.3, 6), fur, 0, 0.3, -0.24);
    tail.rotation.x = -0.5;
    g.add(tail);
    return g;
  },
  'pet-robot': () => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.BoxGeometry(0.24, 0.2, 0.2), toon('#ced4da'), 0, 0.55, 0));
    g.add(mesh(new THREE.BoxGeometry(0.14, 0.05, 0.02), glow('#4cc9f0'), 0, 0.57, 0.11, false));
    g.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 6), toon('#495057'), 0, 0.71, 0, false));
    g.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), glow('#ef476f'), 0, 0.78, 0, false));
    return g;
  },
};

// ---- Trails ---------------------------------------------------------------------------------------------

type Particle = { obj: THREE.Object3D; vel: THREE.Vector3; life: number; max: number };

const spriteCache = new Map<string, THREE.Sprite>();
/** A small emoji or text sprite, its texture shared by every copy. */
function glyph(text: string, color?: string): THREE.Sprite {
  const key = `${text}|${color ?? ''}`;
  let base = spriteCache.get(key);
  if (!base) {
    base = textSprite(text, { size: 40, ...(color ? { color } : {}) });
    base.scale.multiplyScalar(0.55);
    spriteCache.set(key, base);
  }
  const s = new THREE.Sprite(base.material.clone());
  s.scale.copy(base.scale);
  return s;
}

/** A material of its own (toon's are shared), so a particle can fade without fading the rest. */
const spark = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity });

const RAINBOW = ['#ef476f', '#f78c6b', '#ffd166', '#06d6a0', '#118ab2', '#7b2cbf'];
let rainbowAt = 0;

const TRAILS: Record<string, (at: THREE.Vector3) => Particle> = {
  'trail-bubbles': (at) => {
    const m = mesh(new THREE.SphereGeometry(0.05 + Math.random() * 0.04, 10, 8), spark('#a8dadc', 0.55), at.x, at.y + 0.3, at.z, false);
    return { obj: m, vel: new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.5, (Math.random() - 0.5) * 0.2), life: 1.6, max: 1.6 };
  },
  'trail-hearts': (at) => {
    const s = glyph('💖');
    s.position.set(at.x, at.y + 0.4, at.z);
    return { obj: s, vel: new THREE.Vector3(0, 0.45, 0), life: 1.3, max: 1.3 };
  },
  'trail-sparkles': (at) => {
    const m = mesh(new THREE.OctahedronGeometry(0.04), spark(Math.random() < 0.5 ? '#ffd60a' : '#ffffff'), at.x + (Math.random() - 0.5) * 0.4, at.y + 0.2 + Math.random() * 0.8, at.z + (Math.random() - 0.5) * 0.4, false);
    return { obj: m, vel: new THREE.Vector3(0, 0.15, 0), life: 0.9, max: 0.9 };
  },
  'trail-code': (at) => {
    const s = glyph(Math.random() < 0.5 ? '0' : '1', '#06d6a0');
    s.position.set(at.x + (Math.random() - 0.5) * 0.3, at.y + 0.2, at.z + (Math.random() - 0.5) * 0.3);
    return { obj: s, vel: new THREE.Vector3(0, 0.3, 0), life: 1.4, max: 1.4 };
  },
  'trail-rainbow': (at) => {
    const color = RAINBOW[rainbowAt++ % RAINBOW.length]!;
    const m = mesh(new THREE.BoxGeometry(0.16, 0.02, 0.16), spark(color, 0.9), at.x, at.y + 0.02, at.z, false);
    return { obj: m, vel: new THREE.Vector3(), life: 2.2, max: 2.2 };
  },
};

const NAMETAGS: Record<string, string> = { 'tag-pixel': '👾', 'tag-neon': '💡', 'tag-gold': '🥇' };

// ---- Wearing them -------------------------------------------------------------------------------------

type Worn = {
  key: string;
  outfit: NexuraOutfit | undefined;
  pieces: THREE.Object3D[];
  pet?: THREE.Group;
  badge?: THREE.Sprite;
  last: THREE.Vector3;
  walked: number;
};

const worn = new WeakMap<Person, Worn>();
const particles: Particle[] = [];

function undress(person: Person, w: Worn, scene: THREE.Scene) {
  for (const piece of w.pieces) piece.removeFromParent();
  w.pieces = [];
  if (w.pet) scene.remove(w.pet);
  w.pet = undefined;
  if (w.badge) {
    w.badge.removeFromParent();
    disposeSprite(w.badge);
  }
  w.badge = undefined;
  // The holiday hat comes back once ours is off.
  for (const hat of partsOf(person).hat) hat.visible = true;
}

/** Puts `outfit` on `person` (or takes off what they had), building only when it changed. */
export function dress(person: Person, outfit: NexuraOutfit | undefined, scene: THREE.Scene): void {
  // A new build refits what hangs on the body, so it counts as a change too.
  const fit = bodyFit(person);
  const key = `${outfitKey(outfit)}|${fit.key}`;
  let w = worn.get(person);
  if (w && w.key === key) return;
  if (!w) {
    w = { key: '', outfit: undefined, pieces: [], last: person.root.position.clone(), walked: 0 };
    worn.set(person, w);
  }
  undress(person, w, scene);
  w.key = key;
  w.outfit = outfit;
  if (!outfit) return;
  const { head, body } = partsOf(person);
  const hat = outfit.hat ? HATS[outfit.hat]?.() : undefined;
  if (hat) {
    head.add(hat);
    w.pieces.push(hat);
    for (const holiday of partsOf(person).hat) holiday.visible = false;
  }
  const acc = outfit.accessory ? ACCESSORIES[outfit.accessory]?.() : undefined;
  if (acc) {
    if (acc.on === 'body') acc.obj.scale.set(fit.x, 1, fit.z);
    (acc.on === 'head' ? head : body).add(acc.obj);
    w.pieces.push(acc.obj);
  }
  const pet = outfit.pet ? PETS[outfit.pet]?.() : undefined;
  if (pet) {
    pet.position.copy(person.root.position).add(new THREE.Vector3(0.6, 0, -0.6));
    scene.add(pet);
    w.pet = pet;
  }
  const badge = outfit.nametag ? NAMETAGS[outfit.nametag] : undefined;
  if (badge) {
    w.badge = textSprite(badge, { size: 40 });
    w.badge.scale.multiplyScalar(0.7);
    person.root.add(w.badge);
  }
}

/** Takes everything off someone who left (their pet goes with them). */
export function forget(person: Person, scene: THREE.Scene): void {
  const w = worn.get(person);
  if (w) undress(person, w, scene);
  worn.delete(person);
}

const behind = new THREE.Vector3();

/** Each frame: pets follow, trails fall behind whoever walks, badges keep by their name tag. */
export function animate(people: Iterable<Person>, scene: THREE.Scene, dt: number, t: number): void {
  for (const person of people) {
    const w = worn.get(person);
    if (!w?.outfit) continue;
    // A holiday costume can be put on after ours: our hat goes over it, so it hides.
    if (w.outfit.hat) for (const holiday of partsOf(person).hat) holiday.visible = false;
    const at = person.root.position;
    const moved = at.distanceTo(w.last);
    if (w.pet) {
      // Half a meter behind and to the side, catching up at its own pace; a hop when it runs.
      behind.set(0.55, 0, -0.55).applyAxisAngle(THREE.Object3D.DEFAULT_UP, person.root.rotation.y).add(at);
      const pet = w.pet;
      const gap = pet.position.distanceTo(behind);
      if (gap > 6) pet.position.copy(behind);
      else pet.position.lerp(behind, Math.min(1, dt * 3));
      pet.position.y = behind.y + (gap > 0.15 ? Math.abs(Math.sin(t * 12)) * 0.06 : 0) + (w.outfit.pet === 'pet-robot' ? Math.sin(t * 2) * 0.05 : 0);
      if (gap > 0.05) pet.rotation.y = Math.atan2(behind.x - pet.position.x, behind.z - pet.position.z);
    }
    if (w.badge) {
      const label = partsOf(person).label;
      if (label) {
        w.badge.visible = label.visible;
        w.badge.position.set(label.position.x - label.scale.x / 2 - 0.12, label.position.y, label.position.z);
      }
    }
    const trail = w.outfit.trail ? TRAILS[w.outfit.trail] : undefined;
    if (trail && moved > 0.001 && moved < 2) {
      w.walked += moved;
      while (w.walked > 0.35 && particles.length < 400) {
        w.walked -= 0.35;
        const p = trail(at);
        scene.add(p.obj);
        particles.push(p);
      }
    }
    w.last.copy(at);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life -= dt;
    p.obj.position.addScaledVector(p.vel, dt);
    const fade = Math.max(0, p.life / p.max);
    const mat = (p.obj as THREE.Mesh | THREE.Sprite).material as THREE.Material & { opacity: number };
    mat.opacity = Math.min(mat.opacity, fade);
    if (p.life <= 0) {
      scene.remove(p.obj);
      if (p.obj instanceof THREE.Mesh) p.obj.geometry.dispose();
      mat.dispose();
      particles.splice(i, 1);
    }
  }
}
