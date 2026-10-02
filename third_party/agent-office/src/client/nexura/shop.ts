// nexura: Nexura's shop in the office: a market stall by the elevator (E opens it), the same window
// from the coins in the corner, and your collection to put things on and take them off. What's for
// sale changes at midnight; Nexura keeps the wallet (see wallet.ts).
import * as THREE from 'three';
import { boxFootprint } from '../../shared/maps/props';
import { aside, hintTitle, key } from '../core/hint';
import { h, openModal } from '../ui/dom';
import { mesh, roundedBox, textPlane, toon } from '../world/toon';
import type { Collider, Interactable } from '../world/types';
import type { Fixture } from '../world/office/fixture';
import { PLACES } from './places';
import { nexuraThing } from './things';
import { item, loadWallet, nexura, onWallet, wallet, walletConnected, setWallet, type Rewards, type ShopItem } from './wallet';

const RARITY: Record<ShopItem['rarity'], string> = { common: 'Común', rare: 'Rara', epic: 'Épica', legendary: 'Legendaria' };
const KIND: Record<ShopItem['kind'], string> = { hat: 'Sombrero', accessory: 'Complemento', pet: 'Mascota', trail: 'Estela', nametag: 'Placa de nombre', room: 'Sala', game: 'Juego' };
const SLOTS = ['hat', 'accessory', 'pet', 'trail', 'nametag'] as const;

function countdown(nextAt: string): string {
  const left = Math.max(0, new Date(nextAt).getTime() - Date.now());
  const hh = Math.floor(left / 3_600_000);
  const mm = Math.floor((left % 3_600_000) / 60_000);
  return `${hh} h ${String(mm).padStart(2, '0')} min`;
}

/** The shop's window: today's offers, your coins, and your collection. */
export function openShop(): void {
  const body = h('div.body.nx-shop-body');
  const status = h('p.nx-shop-status', { role: 'status' });
  let busy = false;

  const act = async (what: Promise<Rewards>, done: string) => {
    busy = true;
    status.textContent = '…';
    try {
      setWallet(await what);
      status.textContent = done;
    } catch (err) {
      status.textContent = `⚠️ ${(err as Error).message}`;
    } finally {
      busy = false;
      render();
    }
  };

  const render = () => {
    const w = wallet();
    if (!w) {
      body.replaceChildren(h('p.nx-ach-empty', {}, walletConnected() ? 'Cargando…' : 'La tienda está cerrada: arranca la oficina junto a Nexura (npm run start:all) para ganar y gastar monedas.'));
      return;
    }
    const offers = w.shop.offers.map((o) => ({ ...o, item: item(o.itemId) })).filter((o): o is typeof o & { item: ShopItem } => !!o.item);
    const owned = w.catalog.filter((i) => w.owned.includes(i.id));
    body.replaceChildren(
      h(
        'div.nx-shop-hero',
        {},
        h('div.nx-shop-coins', {}, h('span', { 'aria-hidden': 'true' }, '🪙'), h('b', {}, String(w.coins)), h('small', {}, `+${w.earnedToday} hoy`)),
        h('div.nx-shop-when', {}, 'La tienda cambia en ', h('b', {}, countdown(w.shop.nextAt))),
      ),
      h('h3.nx-ach-group', {}, 'Hoy en la tienda'),
      h(
        'div.nx-shop-grid',
        {},
        ...offers.map((o) =>
          h(
            'div.nx-shop-card',
            { class: `${o.item.rarity}${o.deal ? ' deal' : ''}` },
            o.deal ? h('span.nx-shop-deal', {}, 'Oferta del día') : '',
            h('div.nx-shop-icon', { 'aria-hidden': 'true' }, o.item.icon),
            h('div.nx-shop-name', {}, o.item.name),
            h('div.nx-shop-tags', {}, h('span', { class: `r ${o.item.rarity}` }, RARITY[o.item.rarity]), h('span', {}, KIND[o.item.kind])),
            h('p.nx-shop-desc', {}, o.item.description),
            h(
              'div.nx-shop-buy',
              {},
              h('span.nx-shop-price', {}, `🪙 ${o.price}`, o.deal ? h('s', {}, String(o.item.price)) : ''),
              o.owned
                ? h('span.nx-shop-owned', {}, '✓ Tuyo')
                : h(
                    'button.btn.primary',
                    { type: 'button', disabled: busy || w.coins < o.price, onclick: () => void act(nexura<Rewards>('rewards/buy', { itemId: o.itemId }), `¡${o.item.icon} ${o.item.name} es tuyo!`) },
                    w.coins < o.price ? `Faltan ${o.price - w.coins}` : 'Comprar',
                  ),
            ),
          ),
        ),
      ),
      h('h3.nx-ach-group', {}, 'Tu colección'),
      owned.length
        ? h(
            'div.nx-shop-wardrobe',
            {},
            ...owned.map((i) => {
              const slot = (SLOTS as readonly string[]).includes(i.kind) ? (i.kind as (typeof SLOTS)[number]) : null;
              const on = slot ? w.equipped[slot] === i.id : false;
              return slot
                ? h('button.nx-shop-piece', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), disabled: busy, onclick: () => void act(nexura<Rewards>('rewards/equip', { slot, itemId: on ? null : i.id }), on ? `Te has quitado ${i.name}` : `Te has puesto ${i.name}`) }, `${i.icon} ${i.name}`, h('small', {}, on ? 'puesto' : 'ponérselo'))
                : h('span.nx-shop-piece.unlocked', {}, `${i.icon} ${i.name}`, h('small', {}, 'desbloqueado'));
            }),
          )
        : h('p.nx-ach-empty', {}, 'Aún no tienes nada. Lo que compres para tu personaje lo verá toda la planta.'),
      status,
    );
  };

  render();
  const off = onWallet(render);
  const el = h('div.modal.nx-ach-modal.nx-shop-modal', { role: 'dialog', 'aria-label': 'Tienda de Nexura' }, h('header', {}, h('h2', {}, '🛍️ Tienda de Nexura')), body);
  openModal(el, { doing: '🛍️ en la tienda', onClose: off });
  void loadWallet();
}

// ---- The stall --------------------------------------------------------------------------------------------

/** A market stall with a striped awning, a counter with the day's goods on it, and its sign. Facing +z. */
function buildStall(): { group: THREE.Group; collider: Collider; interactable: Interactable } {
  const g = new THREE.Group();
  const wood = toon('#8d5a3b');
  g.add(mesh(roundedBox(1.9, 1, 0.7, 0.05), wood, 0, 0.5, 0));
  g.add(mesh(new THREE.BoxGeometry(2.0, 0.06, 0.8), toon('#e9c46a'), 0, 1.03, 0));
  for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.3, 8), wood, sx * 0.92, 1.15, -0.3));
  // The awning: red and white stripes, sloping down to the front.
  for (let i = 0; i < 8; i++) {
    const stripe = mesh(new THREE.BoxGeometry(0.25, 0.04, 1.1), toon(i % 2 ? '#fdfdfd' : '#e63946'), -0.875 + i * 0.25, 2.25, 0.05);
    stripe.rotation.x = 0.28;
    g.add(stripe);
  }
  // Goods on the counter: a hat, a duckling, a gem.
  g.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 14), toon('#1b1b1b'), -0.55, 1.16, 0.05));
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 16), toon('#1b1b1b'), -0.55, 1.07, 0.05));
  g.add(mesh(new THREE.SphereGeometry(0.11, 12, 10), toon('#ffd60a'), 0, 1.15, 0.05));
  g.add(mesh(new THREE.OctahedronGeometry(0.1), toon('#4cc9f0', { emissive: '#4cc9f0' }), 0.55, 1.2, 0.05, false));
  const sign = textPlane('🛍️ Tienda de Nexura', { size: 46, bg: '#fffaf3' });
  sign.scale.multiplyScalar(0.62);
  sign.position.set(0, 2.62, 0.25);
  g.add(sign);
  const front = textPlane('E · Comprar', { size: 30, bg: '#e9c46a' });
  front.position.set(0, 0.55, 0.36);
  g.add(front);
  const { x, z, rotY } = PLACES.shop;
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  const [minX, maxX, minZ, maxZ] = boxFootprint(x, z, 2, 0.8, rotY);
  const collider: Collider = { minX, maxX, minZ, maxZ, top: 1.1 };
  const interactable: Interactable = { kind: 'nexura', nexura: 'shop', x: x + Math.sin(rotY) * 1.2, z: z + Math.cos(rotY) * 1.2, radius: 1.5 };
  g.userData.interact = interactable;
  return { group: g, collider, interactable };
}

export const shopFixture: Fixture = () => {
  const stall = buildStall();
  return { group: stall.group, colliders: [stall.collider], interactables: [stall.interactable] };
};

nexuraThing('shop', {
  hint: () => {
    const w = wallet();
    return { k: `shop${w?.coins}${w?.shop.day}`, parts: [hintTitle('🛍️ Tienda de Nexura'), w ? aside(`🪙 ${w.coins} · cambia en ${countdown(w.shop.nextAt)}`) : aside('sin conexión con Nexura'), key('E', 'Ver la tienda')] };
  },
  use: (_it, k) => {
    if (k === 'E') openShop();
  },
});
