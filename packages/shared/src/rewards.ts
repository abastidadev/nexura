/**
 * Coins and the shop. Nexura pays coins for real work (flows, merges, reviews, trophies) and for
 * playing in the 3D office; the shop sells looks for your character there and unlocks a few rooms
 * and games. Its stock changes every day. The catalog and the daily pick are pure data and code here,
 * so the server, the web and the office agree on them; the server keeps the wallet
 * (apps/server/src/rewards).
 */
import type { AchievementTier } from "./achievements.ts";

export type ShopRarity = "common" | "rare" | "epic" | "legendary";

/** Where a cosmetic goes on your character: one item per slot at a time. */
export type ShopSlot = "hat" | "accessory" | "pet" | "trail" | "nametag";

/** A cosmetic for one slot, a room of the office, or a game in it. */
export type ShopKind = ShopSlot | "room" | "game";

export type ShopItem = {
  id: string;
  kind: ShopKind;
  rarity: ShopRarity;
  /** One emoji, for lists and the shop's shelves. */
  icon: string;
  name: string;
  description: string;
  price: number;
};

export const SHOP_RARITY_LABELS: Record<ShopRarity, string> = { common: "Común", rare: "Rara", epic: "Épica", legendary: "Legendaria" };

export const SHOP_KIND_LABELS: Record<ShopKind, string> = {
  hat: "Sombrero",
  accessory: "Complemento",
  pet: "Mascota",
  trail: "Estela",
  nametag: "Placa de nombre",
  room: "Sala",
  game: "Juego",
};

export const SHOP_SLOTS: readonly ShopSlot[] = ["hat", "accessory", "pet", "trail", "nametag"];

export const SHOP_ITEMS: readonly ShopItem[] = [
  // ---- Hats
  { id: "hat-cap", kind: "hat", rarity: "common", icon: "🧢", name: "Gorra", description: "Una gorra de las de toda la vida.", price: 60 },
  { id: "hat-beanie", kind: "hat", rarity: "common", icon: "🧶", name: "Gorro de lana", description: "Para las mañanas de despliegue.", price: 60 },
  { id: "hat-headphones", kind: "hat", rarity: "common", icon: "🎧", name: "Auriculares", description: "Modo concentración: no molestar.", price: 90 },
  { id: "hat-chef", kind: "hat", rarity: "rare", icon: "👨‍🍳", name: "Gorro de chef", description: "Para quien cocina los mejores commits.", price: 140 },
  { id: "hat-cowboy", kind: "hat", rarity: "rare", icon: "🤠", name: "Sombrero vaquero", description: "Yeehaw, a producción.", price: 160 },
  { id: "hat-tophat", kind: "hat", rarity: "rare", icon: "🎩", name: "Chistera", description: "Elegancia para las reviews.", price: 200 },
  { id: "hat-viking", kind: "hat", rarity: "epic", icon: "🪖", name: "Casco vikingo", description: "Para asaltar el backlog.", price: 300 },
  { id: "hat-wizard", kind: "hat", rarity: "epic", icon: "🧙", name: "Sombrero de mago", description: "Cualquier tecnología lo bastante avanzada…", price: 320 },
  { id: "hat-crown", kind: "hat", rarity: "legendary", icon: "👑", name: "Corona", description: "Reina o rey del tablero.", price: 650 },
  { id: "hat-halo", kind: "hat", rarity: "legendary", icon: "😇", name: "Aureola", description: "Nunca has roto main. Casi nunca.", price: 800 },

  // ---- Accessories
  { id: "acc-sunglasses", kind: "accessory", rarity: "common", icon: "🕶️", name: "Gafas de sol", description: "El futuro es tan brillante…", price: 80 },
  { id: "acc-bowtie", kind: "accessory", rarity: "common", icon: "🎀", name: "Pajarita", description: "Para las demos importantes.", price: 70 },
  { id: "acc-scarf", kind: "accessory", rarity: "rare", icon: "🧣", name: "Bufanda", description: "Abrigada para el aire acondicionado.", price: 110 },
  { id: "acc-cape", kind: "accessory", rarity: "epic", icon: "🦸", name: "Capa", description: "No todos los héroes llevan capa. Tú sí.", price: 280 },
  { id: "acc-jetpack", kind: "accessory", rarity: "legendary", icon: "🚀", name: "Mochila cohete", description: "No vuela, pero echa humo con estilo.", price: 600 },

  // ---- Pets (they follow you around the office)
  { id: "pet-duckling", kind: "pet", rarity: "rare", icon: "🐥", name: "Patito", description: "Un patito de goma que te sigue a todas partes.", price: 300 },
  { id: "pet-cat", kind: "pet", rarity: "epic", icon: "🐈", name: "Gato", description: "Se sienta en tu teclado cuando menos lo esperas.", price: 450 },
  { id: "pet-robot", kind: "pet", rarity: "legendary", icon: "🤖", name: "Robot ayudante", description: "Un pequeño agente que flota a tu lado.", price: 700 },

  // ---- Trails (left behind as you walk)
  { id: "trail-bubbles", kind: "trail", rarity: "common", icon: "🫧", name: "Burbujas", description: "Pompas a cada paso.", price: 120 },
  { id: "trail-hearts", kind: "trail", rarity: "rare", icon: "💖", name: "Corazones", description: "Repartes buen rollo.", price: 160 },
  { id: "trail-sparkles", kind: "trail", rarity: "rare", icon: "✨", name: "Destellos", description: "Brillas al andar.", price: 180 },
  { id: "trail-code", kind: "trail", rarity: "epic", icon: "💾", name: "Ceros y unos", description: "Dejas un rastro de bits.", price: 350 },
  { id: "trail-rainbow", kind: "trail", rarity: "legendary", icon: "🌈", name: "Arcoíris", description: "Un arcoíris te sigue por la oficina.", price: 500 },

  // ---- Name tags
  { id: "tag-pixel", kind: "nametag", rarity: "common", icon: "👾", name: "Placa pixel", description: "Tu nombre en estilo 8 bits.", price: 100 },
  { id: "tag-neon", kind: "nametag", rarity: "rare", icon: "💡", name: "Placa neón", description: "Tu nombre brilla en la oscuridad.", price: 150 },
  { id: "tag-gold", kind: "nametag", rarity: "epic", icon: "🥇", name: "Placa dorada", description: "Tu nombre en oro.", price: 260 },

  // ---- Rooms and games to unlock
  { id: "room-hall-of-fame", kind: "room", rarity: "epic", icon: "🖼️", name: "Galería de la fama", description: "Un pasillo con un cuadro por cada PR que tus flujos han conseguido integrar.", price: 400 },
  { id: "game-trivia", kind: "game", rarity: "rare", icon: "❓", name: "Trivial del repo", description: "Una recreativa que te pregunta por la historia de tus repos (sacada de git). Paga monedas por acierto.", price: 300 },
  { id: "game-race", kind: "game", rarity: "epic", icon: "🏎️", name: "Gran Premio de flujos", description: "Un circuito en la azotea: tus flujos en marcha compiten y puedes apostar por el ganador.", price: 350 },
  { id: "game-futbolin", kind: "game", rarity: "epic", icon: "⚽", name: "Futbolín", description: "Una mesa de futbolín en la sala de juegos: contra la máquina o a dos jugadores en el mismo teclado.", price: 500 },
];

export const SHOP_ITEM_BY_ID: ReadonlyMap<string, ShopItem> = new Map(SHOP_ITEMS.map((item) => [item.id, item]));

/** What equipping does: only cosmetics go in a slot. */
export function isCosmetic(item: ShopItem): item is ShopItem & { kind: ShopSlot } {
  return (SHOP_SLOTS as readonly string[]).includes(item.kind);
}

/** Rooms and games that start locked: the office checks these before letting you in. */
export const SHOP_UNLOCKABLES = SHOP_ITEMS.filter((item) => item.kind === "room" || item.kind === "game").map((item) => item.id);

// ---- Earning -------------------------------------------------------------------------------------

/** Coins for a trophy, by tier. */
export const COINS_PER_TIER: Record<AchievementTier, number> = { bronze: 25, silver: 60, gold: 150, platinum: 500 };

/** Coins for each kind of work or play (see apps/server/src/rewards/rules.ts). */
export const COIN_REWARDS = {
  welcome: 100,
  flow: 20,
  firstTry: 10,
  merge: 40,
  review: 25,
  ticketCreated: 10,
  dailyVisit: 10,
  duck: 15,
  duckSeason: 75,
  triviaCorrect: 5,
  futbolinWin: 15,
} as const;

/** Most coins a game pays in one day, so playing all day can't outpay working. */
export const DAILY_GAME_CAP = { trivia: 50, futbolin: 45 } as const;

/** How to earn coins, for the shop's "¿Cómo gano monedas?". */
export const COIN_RULES: readonly { icon: string; text: string; coins: string }[] = [
  { icon: "🏆", text: "Desbloquea un logro (según su nivel)", coins: `${COINS_PER_TIER.bronze}–${COINS_PER_TIER.platinum}` },
  { icon: "✅", text: "Termina bien un flujo", coins: `${COIN_REWARDS.flow}` },
  { icon: "🎯", text: "…sin que vuelva a implementar", coins: `+${COIN_REWARDS.firstTry}` },
  { icon: "🔀", text: "Consigue que se integre la PR de un flujo", coins: `${COIN_REWARDS.merge}` },
  { icon: "👁️", text: "Publica una revisión de una PR ajena", coins: `${COIN_REWARDS.review}` },
  { icon: "✍️", text: "Crea un ticket con el asistente", coins: `${COIN_REWARDS.ticketCreated}` },
  { icon: "🏢", text: "Pasa por la Oficina 3D (una vez al día)", coins: `${COIN_REWARDS.dailyVisit}` },
  { icon: "🦆", text: "Encuentra un patito de la temporada (cambian cada semana)", coins: `${COIN_REWARDS.duck}` },
  { icon: "🛁", text: "…los cinco de la semana", coins: `+${COIN_REWARDS.duckSeason}` },
  { icon: "🎲", text: "Acierta tu apuesta en la porra o el Gran Premio", coins: "×2 o más" },
  { icon: "❓", text: "Acierta en el Trivial del repo", coins: `${COIN_REWARDS.triviaCorrect} (máx. ${DAILY_GAME_CAP.trivia}/día)` },
  { icon: "⚽", text: "Gana al futbolín a la máquina", coins: `${COIN_REWARDS.futbolinWin} (máx. ${DAILY_GAME_CAP.futbolin}/día)` },
];

// ---- The daily shop ------------------------------------------------------------------------------

/** How many offers the shop has each day. */
export const SHOP_OFFERS = 6;
/** The deal of the day: this much off one offer. */
export const SHOP_DEAL = 0.3;

export type ShopOffer = { itemId: string; price: number; deal: boolean };

const RARITY_WEIGHT: Record<ShopRarity, number> = { common: 50, rare: 30, epic: 15, legendary: 5 };

/** A small seeded random generator (mulberry32), so a day always draws the same shop. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick<T extends ShopItem>(pool: T[], random: () => number): T {
  const total = pool.reduce((sum, item) => sum + RARITY_WEIGHT[item.rarity], 0);
  let roll = random() * total;
  for (const item of pool) {
    roll -= RARITY_WEIGHT[item.rarity];
    if (roll < 0) return item;
  }
  return pool[pool.length - 1]!;
}

/**
 * The shop of day `day` (YYYY-MM-DD) for someone who owns `owned`. It always brings a room or a game
 * while any is still locked, fills the rest with cosmetics you don't have yet (rarer ones less often),
 * and puts one on offer. Only when there aren't enough new things left does it show ones you own.
 */
export function drawShop(day: string, owned: ReadonlySet<string>): ShopOffer[] {
  const random = seeded(`nexura-shop:${day}`);
  const picked: ShopItem[] = [];
  const take = (pool: ShopItem[]) => {
    const free = pool.filter((item) => !picked.includes(item));
    if (free.length) picked.push(weightedPick(free, random));
  };
  const unlockables = SHOP_ITEMS.filter((item) => (item.kind === "room" || item.kind === "game") && !owned.has(item.id));
  if (unlockables.length) take(unlockables);
  const cosmetics = SHOP_ITEMS.filter((item) => isCosmetic(item) && !owned.has(item.id));
  while (picked.length < SHOP_OFFERS && cosmetics.some((item) => !picked.includes(item))) take(cosmetics);
  const rest = SHOP_ITEMS.filter((item) => !picked.includes(item));
  while (picked.length < SHOP_OFFERS && rest.some((item) => !picked.includes(item))) take(rest);
  const deal = Math.floor(random() * picked.length);
  return picked.map((item, i) => ({ itemId: item.id, price: i === deal ? Math.round(item.price * (1 - SHOP_DEAL)) : item.price, deal: i === deal }));
}

/** The local calendar day of `date`, as YYYY-MM-DD: the shop changes at local midnight. */
export function shopDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The ISO week of a date (`2026-W40`): the rubber ducks hide somewhere else every week. */
export function duckSeason(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ---- Bets ---------------------------------------------------------------------------------------

/**
 * A bet on a flow: `first-try` / `retry` (the porra: will it get through review and QA without going
 * back to implement?) or `race` (the Grand Prix: which of the flows running will finish first).
 */
export type BetKind = "first-try" | "retry" | "race";

export type Bet = {
  id: string;
  kind: BetKind;
  runId: string;
  /** The race's runners when it was placed. */
  field?: string[];
  stake: number;
  placedAt: string;
  status: "open" | "won" | "lost" | "refunded";
  payout?: number;
  settledAt?: string;
};

export const BET_LIMITS = { min: 10, max: 200 } as const;

// ---- What the server sends ----------------------------------------------------------------------

export type CoinEntry = { key: string; at: string; amount: number; reason: string };

export type RewardsSummary = {
  coins: number;
  /** Earned since local midnight (spending not counted). */
  earnedToday: number;
  history: CoinEntry[];
  owned: string[];
  equipped: Partial<Record<ShopSlot, string>>;
  shop: { day: string; nextAt: string; offers: (ShopOffer & { owned: boolean })[] };
  bets: Bet[];
  /** This week's duck season and the ducks found in it. */
  ducks: { season: string; found: number[] };
  /** The whole catalog, so the 3D office needs no copy of it. */
  catalog: readonly ShopItem[];
};

/** What the 3D office reports for coins (besides the achievement events). */
export type OfficeRewardEvent =
  | { kind: "visit" }
  | { kind: "duck"; duck: number; season: string }
  | { kind: "game"; game: "futbolin"; result: "win" | "loss" };

/** A trivia question about one of the configured repos, made from git (zero tokens). */
export type TriviaQuestion = { id: string; repo: string; question: string; options: string[] };
export type TriviaAnswer = { correct: boolean; answer: string; coins: number; earnedToday: number };

/** Pages of Nexura the 3D office may open (Revisiones from the reviews board, the shop…). */
export const OFFICE_PAGES = { reviews: "/reviews", shop: "/shop", achievements: "/achievements", metrics: "/metrics", runs: "/runs" } as const;
export type OfficePage = keyof typeof OFFICE_PAGES;

// ---- What the 3D office shows of Nexura ----------------------------------------------------------

/** A flow running, for the control room's monitor wall. */
export type OfficeDigestFlow = {
  runId: string;
  name: string;
  title: string;
  status: string;
  agent: string;
  /** Its pipeline: each step once, in order, with how it stands now. */
  steps: { step: string; status: "pending" | "running" | "succeeded" | "failed" | "skipped" }[];
  current?: string;
  /** Waiting on you: a step to confirm, a PR to approve, or replies to send. */
  waiting?: "step" | "pr" | "replies";
  costUsd: number;
};

/** A PR a flow got merged, for the Hall of Fame. */
export type OfficeDigestMerge = { runId: string; name: string; title: string; url?: string; mergedAt: string; agents: string[] };

/** Everything the office shows of Nexura in one request (zero tokens). */
export type OfficeDigest = {
  active: OfficeDigestFlow[];
  merged: OfficeDigestMerge[];
  today: { flowsDone: number; prsOpened: number; prsMerged: number; reviews: number; costUsd: number; trophies: string[]; coins: number };
  /** Open PRs of other people to review (Revisiones). */
  toReview: { repo: string; id: number; title: string; author: string; url: string; reviewed: boolean }[];
  quota: { label: string; percent: number; resetsAt?: number }[];
};
