import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { lookFromSeed, sameLook, sanitizeLook } from '../src/shared/avatar.js';
import { BODY_TYPES, sanitizeBody } from '../src/shared/nexura-body.js';
import { bodyFit, shapeBody } from '../src/client/nexura/body.js';
import type { Person } from '../src/client/world/character/index.js';

test('nexura: a look keeps a known build, and one without it is the average body', () => {
  const fallback = lookFromSeed('someone');
  assert.equal(sanitizeLook({ ...fallback, body: 3 }, fallback).body, 3);
  assert.equal(sanitizeLook({ ...fallback, body: BODY_TYPES.length }, fallback).body, 0);
  assert.equal(sanitizeLook({ ...fallback, body: 1.5 }, { ...fallback, body: 2 }).body, 2);
  assert.equal(sanitizeLook(fallback, fallback).body, 0);
  assert.equal(sanitizeBody('2'), 0);
  assert.ok(sameLook(fallback, { ...fallback, body: 0 }));
  assert.ok(!sameLook(fallback, { ...fallback, body: 1 }));
});

/** What shapeBody touches on a Person: its torso first on the body, limbs with their capsule (and hand) first. */
function fakePerson(body: number) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.28), new THREE.MeshBasicMaterial()));
  const limb = (x: number, hand: boolean) => {
    const pivot = new THREE.Group();
    pivot.position.x = x;
    pivot.add(new THREE.Mesh());
    if (hand) pivot.add(new THREE.Mesh());
    group.add(pivot);
    return pivot;
  };
  const parts = {
    look: { skin: 0, hair: 0, style: 0, body },
    body: group,
    armL: limb(-0.33, true),
    armR: limb(0.33, true),
    legL: limb(-0.12, false),
    legR: limb(0.12, false),
    cardHolder: new THREE.Group(),
  };
  return { parts, person: parts as unknown as Person };
}

test('nexura: each build stretches the torso and moves the limbs, and changing it swaps the belly or chest', () => {
  const { parts, person } = fakePerson(3);
  shapeBody(person);
  const torso = parts.body.children[0]!;
  assert.ok(torso.scale.x > 1.2 && torso.scale.z > 1.2);
  assert.ok(parts.armR.position.x > 0.36 && parts.armL.position.x < -0.36);
  const withBelly = parts.body.children.length;

  parts.look.body = 1;
  shapeBody(person);
  assert.equal(parts.body.children.length, withBelly - 1);
  assert.ok(torso.scale.x < 1 && parts.armR.position.x < 0.33);
  assert.ok(bodyFit(person).x < 1);

  parts.look.body = 0;
  shapeBody(person);
  assert.deepEqual(torso.scale.toArray(), [1, 1, 1]);
  assert.equal(parts.armR.position.x, 0.33);
  assert.equal(parts.legL.position.x, -0.12);
  assert.equal(parts.cardHolder.position.z, 0.36);
  assert.deepEqual(bodyFit(person), { x: 1, z: 1, key: 0 });
});
