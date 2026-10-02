// nexura: getting up on things and back down (see ledgeSlide in src/client/player/collide.ts).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/client/player/index.js';
import type { Collider } from '../src/client/world/types.js';
import { FLOOR, SLAB } from '../src/shared/layout.js';

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const desk: Collider = { minX: -1.05, maxX: 1.05, minZ: -0.53, maxZ: 0.53, top: 0.78 };

function controller(t: TestContext, colliders: Collider[]) {
  const win = new EventTarget();
  const doc = new EventTarget();
  for (const [name, value] of [['window', win], ['document', doc]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const player = new PlayerController(new THREE.PerspectiveCamera(), new EventTarget() as unknown as HTMLElement, [officeFloor, ...colliders]);
  player.camYaw = 0;
  function keys(...codes: string[]) {
    player.clearKeys();
    for (const code of codes) {
      const event = new Event('keydown');
      Object.defineProperty(event, 'code', { value: code });
      win.dispatchEvent(event);
    }
  }
  function frames(count: number, dt = 1 / 60) {
    for (let i = 0; i < count; i++) player.update(dt);
  }
  return { player, keys, frames };
}

test('stopping with your middle past a desk edge slides you off instead of standing on air', (t) => {
  const { player, frames } = controller(t, [desk]);
  player.pos.set(0, desk.top, desk.minZ - 0.2);
  frames(60);
  assert.equal(player.pos.y, 0, 'down on the floor');
  assert.ok(player.pos.z <= desk.minZ - 0.32, `clear of the desk, at z=${player.pos.z}`);
});

test('standing on a desk with your middle over it, you stay up there', (t) => {
  const { player, frames } = controller(t, [desk]);
  player.pos.set(0, desk.top, desk.minZ + 0.05);
  frames(60);
  assert.equal(player.pos.y, desk.top);
  assert.ok(Math.abs(player.pos.z - (desk.minZ + 0.05)) < 1e-9, 'not pushed about');
});

test('walking off a desk you drop as soon as your middle leaves it, and walk on below', (t) => {
  const { player, keys, frames } = controller(t, [desk]);
  player.pos.set(0, desk.top, 0);
  keys('KeyW');
  // Frames spent up at the desk's height with your middle past its edge: only while your feet clear it.
  let air = 0;
  for (let i = 0; i < 40; i++) {
    frames(1);
    if (player.grounded && player.pos.y > 0.5 && player.pos.z < desk.minZ) air++;
  }
  assert.ok(air <= 3, `stood on air for ${air} frames`);
  assert.equal(player.pos.y, 0);
  keys('KeyD');
  const x = player.pos.x;
  frames(20);
  assert.ok(player.pos.x > x + 1, 'walks on normally once down');
});

test("you can't perch on top of a thin post", (t) => {
  const post: Collider = { minX: -0.05, maxX: 0.05, minZ: -0.05, maxZ: 0.05, top: 1 };
  const { player, frames } = controller(t, [post]);
  player.pos.set(0.2, post.top, 0);
  frames(60);
  assert.equal(player.pos.y, 0);
});

test('two desks side by side are one surface to walk across', (t) => {
  const other: Collider = { ...desk, minX: desk.maxX, maxX: desk.maxX + 2.1 };
  const { player, keys, frames } = controller(t, [desk, other]);
  player.pos.set(0, desk.top, 0);
  keys('KeyD');
  frames(30);
  assert.equal(player.pos.y, desk.top, 'still up on the desks');
  assert.ok(player.pos.x > desk.maxX + 0.5);
});
