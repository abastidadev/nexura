// nexura: what someone wears from Nexura's shop (packages/shared/src/rewards.ts in Nexura), as every
// browser on the floor draws it. The ids are Nexura's; a test there checks the lists still match.

export const NEXURA_OUTFIT = {
  hat: ['hat-cap', 'hat-beanie', 'hat-headphones', 'hat-chef', 'hat-cowboy', 'hat-tophat', 'hat-viking', 'hat-wizard', 'hat-crown', 'hat-halo'],
  accessory: ['acc-sunglasses', 'acc-bowtie', 'acc-scarf', 'acc-cape', 'acc-jetpack'],
  pet: ['pet-duckling', 'pet-cat', 'pet-robot'],
  trail: ['trail-bubbles', 'trail-hearts', 'trail-sparkles', 'trail-code', 'trail-rainbow'],
  nametag: ['tag-pixel', 'tag-neon', 'tag-gold'],
} as const;

export type NexuraOutfitSlot = keyof typeof NEXURA_OUTFIT;
export type NexuraOutfit = { [K in NexuraOutfitSlot]?: (typeof NEXURA_OUTFIT)[K][number] };

/** Only known items, each in its own slot; undefined when nothing is left (so nothing goes on the wire). */
export function sanitizeOutfit(raw: unknown): NexuraOutfit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const slot of Object.keys(NEXURA_OUTFIT) as NexuraOutfitSlot[]) {
    const v = r[slot];
    if (typeof v === 'string' && (NEXURA_OUTFIT[slot] as readonly string[]).includes(v)) out[slot] = v;
  }
  return Object.keys(out).length ? (out as NexuraOutfit) : undefined;
}

/** A key that changes whenever the outfit does. */
export function outfitKey(o: NexuraOutfit | undefined): string {
  return o ? (Object.keys(NEXURA_OUTFIT) as NexuraOutfitSlot[]).map((s) => o[s] ?? '').join('|') : '';
}
