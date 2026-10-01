// nexura: Nexura's coins and shop in the office (packages/shared/src/rewards.ts and
// apps/server/src/rewards in Nexura). The wallet is Nexura's: the office asks it through its own server
// (server/nexura/proxy.ts), shows the balance in a corner, opens the shop at its kiosk, and tells every
// browser on the floor what you wear (PeerInfo.nexura).
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { sanitizeOutfit, type NexuraOutfit } from '../../shared/nexura-outfit';

export type ShopKind = 'hat' | 'accessory' | 'pet' | 'trail' | 'nametag' | 'room' | 'game';
export type ShopRarity = 'common' | 'rare' | 'epic' | 'legendary';
export interface ShopItem {
  id: string;
  kind: ShopKind;
  rarity: ShopRarity;
  icon: string;
  name: string;
  description: string;
  price: number;
}
export interface Bet {
  id: string;
  kind: 'first-try' | 'retry' | 'race';
  runId: string;
  field?: string[];
  stake: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout?: number;
}
/** What Nexura's /api/rewards answers (RewardsSummary). */
export interface Rewards {
  coins: number;
  earnedToday: number;
  history: { key: string; at: string; amount: number; reason: string }[];
  owned: string[];
  equipped: Partial<Record<'hat' | 'accessory' | 'pet' | 'trail' | 'nametag', string>>;
  shop: { day: string; nextAt: string; offers: { itemId: string; price: number; deal: boolean; owned: boolean }[] };
  bets: Bet[];
  ducks: { season: string; found: number[] };
  catalog: ShopItem[];
}

let rewards: Rewards | null = null;
let connected = false;
const listeners = new Set<() => void>();
let net: Net | null = null;
let chip: HTMLElement | null = null;

export function wallet(): Rewards | null {
  return rewards;
}

export function walletConnected(): boolean {
  return connected;
}

export function onWallet(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function item(id: string): ShopItem | undefined {
  return rewards?.catalog.find((i) => i.id === id);
}

/** Whether a room or game of the shop is yours. Without Nexura there's no shop, so nothing is locked. */
export function owns(itemId: string): boolean {
  if (!connected) return true;
  return rewards?.owned.includes(itemId) ?? false;
}

/** What to say at something locked: its price and where to get it. */
export function lockedText(itemId: string): string {
  const it = item(itemId);
  const today = rewards?.shop.offers.find((o) => o.itemId === itemId);
  return `🔒 ${it?.name ?? 'Bloqueado'} · ${today ? `hoy en la tienda por 🪙 ${today.price}` : 'aparecerá algún día en la tienda'}`;
}

/** A request to Nexura through the office: JSON in and out, its error message as the thrown error. */
export async function nexura<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/nexura/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function outfit(): NexuraOutfit | undefined {
  return sanitizeOutfit(rewards?.equipped);
}

/** Tells the floor what you wear, along with the rest of your profile. */
export function sendOutfit(): void {
  if (!net || !rewards) return;
  const p = store.profile;
  net.send({ t: 'profile', name: p.name, color: p.color, look: p.look, nexura: outfit() ?? {} });
}

/** Takes in a fresh summary: the balance, a toast for coins earned (when Nexura isn't showing it), and the outfit. */
export function setWallet(next: Rewards): void {
  const before = rewards;
  rewards = next;
  connected = true;
  if (before && next.coins > before.coins && window.parent === window) toast(`🪙 +${next.coins - before.coins} monedas`);
  if (!before || JSON.stringify(before.equipped) !== JSON.stringify(next.equipped)) sendOutfit();
  renderChip();
  listeners.forEach((fn) => fn());
}

export async function loadWallet(): Promise<void> {
  try {
    setWallet(await nexura<Rewards>('rewards'));
  } catch {
    connected = false;
    renderChip();
  }
}

function renderChip() {
  if (!chip) return;
  chip.hidden = !connected || !rewards;
  if (rewards) chip.replaceChildren(h('span', { 'aria-hidden': 'true' }, '🪙'), h('b', {}, String(rewards.coins)), h('small', {}, 'Tienda'));
}

/** The balance in the corner, polled now and then, and the outfit sent whenever you (re)join. */
export function startWallet(n: Net, openShop: () => void): void {
  net = n;
  chip = h('button.nx-wallet', { type: 'button', title: 'Tus monedas de Nexura: abre la tienda', onclick: openShop });
  chip.hidden = true;
  // In the HUD, whose children take clicks over the scene.
  (document.getElementById('hud') ?? document.body).append(chip);
  void loadWallet();
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadWallet();
  }, 20_000);
}
