// nexura: a Person's build (Look.body, see shared/nexura-body.ts): the torso, arms and legs Person
// makes, stretched and moved for a slim, strong or chubby body, with a chest or a belly on top.
// Whatever hangs on the body (the shop's scarf, cape and jetpack) fits itself with bodyFit.
import * as THREE from 'three';
import type { Person } from '../world/character';
import { mesh } from '../world/toon';
import { sanitizeBody } from '../../shared/nexura-body';
import type { Look } from '../../shared/avatar';

/** Person keeps these to itself; the build only stretches and moves them. */
type BodyParts = {
  look: Look;
  body: THREE.Group;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  cardHolder: THREE.Group;
};
const partsOf = (p: Person) => p as unknown as BodyParts;

type Build = {
  /** The torso's stretch across (x), up (y) and front to back (z). */
  torso: [number, number, number];
  /** How thick the arms and legs are, and how far out from the middle they hang. */
  arm: number;
  armX: number;
  leg: number;
  legX: number;
  hand: number;
  /** How much further out in front the issue card is held, clear of a chest or a belly. */
  front: number;
  /** A shape over the torso, in the shirt's material. */
  extra?: (shirt: THREE.Material) => THREE.Object3D;
  /** A shape on top of each arm (it swings with it), in the shirt's material. */
  shoulder?: (shirt: THREE.Material) => THREE.Object3D;
};

// The average one is Person's own measurements: torso a capsule of radius 0.26 at y 0.72, arms at
// x ±0.33 from y 0.9, legs at x ±0.12 from the hips.
const BUILDS: readonly Build[] = [
  { torso: [1, 1, 1], arm: 1, armX: 0.33, leg: 1, legX: 0.12, hand: 1, front: 0 },
  // Slim: narrow and a little taller in the chest, thin arms and legs close in.
  { torso: [0.78, 1.04, 0.8], arm: 0.75, armX: 0.27, leg: 0.78, legX: 0.1, hand: 0.9, front: -0.04 },
  // Strong: a broad chest, big round shoulders and thick arms out wide.
  {
    torso: [1.22, 1.02, 1.06],
    arm: 1.45,
    armX: 0.42,
    leg: 1.2,
    legX: 0.135,
    hand: 1.18,
    front: 0.04,
    extra: (shirt) => {
      const chest = new THREE.Group();
      for (const sx of [-1, 1]) {
        const pec = mesh(new THREE.SphereGeometry(0.13, 14, 10), shirt, sx * 0.12, 0.9, 0.18);
        pec.scale.set(1.1, 0.75, 0.75);
        chest.add(pec);
      }
      return chest;
    },
    shoulder: (shirt) => mesh(new THREE.SphereGeometry(0.15, 16, 12), shirt, 0, -0.04, 0),
  },
  // Chubby: round all over, with a belly out in front and the arms resting on it.
  {
    torso: [1.36, 1, 1.32],
    arm: 1.25,
    armX: 0.4,
    leg: 1.32,
    legX: 0.145,
    hand: 1.12,
    front: 0.1,
    extra: (shirt) => {
      const belly = mesh(new THREE.SphereGeometry(0.3, 20, 16), shirt, 0, 0.62, 0.09);
      belly.scale.set(1.18, 0.92, 1);
      return belly;
    },
  },
];

/** What a build put on top of Person's own shapes, to take off when it changes. */
const extras = new WeakMap<Person, THREE.Object3D[]>();

/** The torso: the first thing Person puts on its body. */
const torsoOf = (p: Person) => partsOf(p).body.children[0] as THREE.Mesh;

/** Shapes `person` to its look's build; called by Person whenever its look is set. */
export function shapeBody(person: Person): void {
  const parts = partsOf(person);
  const build = BUILDS[sanitizeBody(parts.look.body)]!;
  const torso = torsoOf(person);
  torso.scale.set(...build.torso);
  for (const old of extras.get(person) ?? []) {
    old.removeFromParent();
    old.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
  const added: THREE.Object3D[] = [];
  const shirt = torso.material as THREE.Material;
  const put = (on: THREE.Object3D, make: ((shirt: THREE.Material) => THREE.Object3D) | undefined) => {
    const o = make?.(shirt);
    if (!o) return;
    on.add(o);
    added.push(o);
  };
  put(parts.body, build.extra);
  put(parts.armL, build.shoulder);
  put(parts.armR, build.shoulder);
  extras.set(person, added);
  for (const [limb, side] of [[parts.armL, -1], [parts.armR, 1]] as const) {
    limb.position.x = side * build.armX;
    limb.children[0]!.scale.set(build.arm, 1, build.arm);
    limb.children[1]!.scale.setScalar(build.hand);
  }
  for (const [limb, side] of [[parts.legL, -1], [parts.legR, 1]] as const) {
    limb.position.x = side * build.legX;
    limb.children[0]!.scale.set(build.leg, 1, build.leg);
  }
  parts.cardHolder.position.z = 0.36 + build.front;
}

/** How much wider (x) and deeper (z) than the average one `person`'s torso is, for what's worn on it. */
export function bodyFit(person: Person): { x: number; z: number; key: number } {
  const body = sanitizeBody(partsOf(person).look.body);
  const [x, , z] = BUILDS[body]!.torso;
  // The strong one's chest reaches out past its torso.
  return body === 2 ? { x: 1.3, z: 1.18, key: body } : { x, z, key: body };
}
