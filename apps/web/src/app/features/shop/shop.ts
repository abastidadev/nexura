import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, resource, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  BET_LIMITS,
  COIN_RULES,
  SHOP_ITEM_BY_ID,
  SHOP_ITEMS,
  SHOP_KIND_LABELS,
  SHOP_RARITY_LABELS,
  SHOP_SLOTS,
  type Bet,
  type BetKind,
  type RewardsSummary,
  type Run,
  type ShopItem,
  type ShopRarity,
  type ShopSlot,
} from "@nexura/shared";
import { Api } from "../../core/api";
import { NexuraStore, isPrReview } from "../../core/nexura-store";

const RARITY_CHIP: Record<ShopRarity, string> = {
  common: "bg-surface-3 text-fg-soft ring-border",
  rare: "bg-info-soft text-info ring-info/30",
  epic: "bg-[#b07cff]/15 text-[#8a4fe0] ring-[#b07cff]/35",
  legendary: "bg-[#ffc940]/15 text-[#b8860b] ring-[#ffc940]/40",
};

const RARITY_GLOW: Record<ShopRarity, string> = {
  common: "",
  rare: "bg-info/10",
  epic: "bg-[#b07cff]/15",
  legendary: "bg-[#ffc940]/20",
};

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);
/** Where each unlockable lives once bought. */
const WHERE: Record<string, string> = {
  "room-hall-of-fame": "En la Oficina 3D, en la oficina de atrás.",
  "game-trivia": "La recreativa azul de la sala de juegos de la Oficina 3D.",
  "game-race": "El circuito de la azotea de la Oficina 3D; también apuestas desde aquí.",
  "game-futbolin": "La mesa de la sala de juegos de la Oficina 3D.",
};

/**
 * Tienda: the wallet, today's offers (they change at midnight), what you own and wear in the 3D
 * office, bets on the flows running, and how coins are earned. Zero tokens: all of it comes from
 * /api/rewards.
 */
@Component({
  selector: "nx-shop",
  imports: [DatePipe, RouterLink],
  templateUrl: "./shop.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block h-full overflow-y-auto" },
})
export class ShopPage {
  private readonly api = inject(Api);
  protected readonly store = inject(NexuraStore);

  protected readonly rarityChip = RARITY_CHIP;
  protected readonly rarityGlow = RARITY_GLOW;
  protected readonly rarityLabels = SHOP_RARITY_LABELS;
  protected readonly kindLabels = SHOP_KIND_LABELS;
  protected readonly slots = SHOP_SLOTS;
  protected readonly rules = COIN_RULES;
  protected readonly where = WHERE;
  protected readonly betLimits = BET_LIMITS;

  private readonly data = resource({
    params: () => ({ version: this.store.rewardsVersion() }),
    loader: () => this.api.getRewards(),
  });
  /** What a purchase or equip answered, ahead of the next reload. */
  private readonly latest = signal<RewardsSummary | undefined>(undefined);
  protected readonly summary = computed<RewardsSummary | undefined>(() => this.latest() ?? (this.data.hasValue() ? this.data.value() : undefined));
  protected readonly loadError = computed(() => Boolean(this.data.error()));
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly offers = computed(() =>
    (this.summary()?.shop.offers ?? []).map((offer) => ({ ...offer, item: SHOP_ITEM_BY_ID.get(offer.itemId)! })).filter((offer) => offer.item),
  );

  /** What you own, by slot, and the rooms and games unlocked. */
  protected readonly collection = computed(() => {
    const owned = new Set(this.summary()?.owned ?? []);
    const items = SHOP_ITEMS.filter((item) => owned.has(item.id));
    return {
      bySlot: SHOP_SLOTS.map((slot) => ({ slot, items: items.filter((item) => item.kind === slot) })).filter((group) => group.items.length),
      unlocked: items.filter((item) => item.kind === "room" || item.kind === "game"),
      locked: SHOP_ITEMS.filter((item) => (item.kind === "room" || item.kind === "game") && !owned.has(item.id)),
      count: items.length,
    };
  });

  /** Your character as the office shows it: what each slot has on. */
  protected readonly outfit = computed(() =>
    SHOP_SLOTS.map((slot) => ({ slot, item: SHOP_ITEM_BY_ID.get(this.summary()?.equipped[slot] ?? "") })),
  );

  protected readonly activeFlows = computed(() => this.store.runs().filter((run) => !isPrReview(run) && ACTIVE.has(run.status)));
  protected readonly raceUnlocked = computed(() => this.summary()?.owned.includes("game-race") ?? false);
  protected readonly stake = signal(20);

  /** Time left until the shop changes, refreshed every second. */
  private readonly clock = signal(Date.now());
  protected readonly countdown = computed(() => {
    const next = this.summary()?.shop.nextAt;
    if (!next) return "";
    const left = Math.max(0, new Date(next).getTime() - this.clock());
    const h = Math.floor(left / 3_600_000);
    const m = Math.floor((left % 3_600_000) / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  });

  public constructor() {
    const timer = setInterval(() => {
      this.clock.set(Date.now());
      // Past midnight: a new shop.
      const next = this.summary()?.shop.nextAt;
      if (next && Date.now() >= new Date(next).getTime() + 1000) {
        this.latest.set(undefined);
        this.data.reload();
      }
    }, 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected canAfford(price: number): boolean {
    return (this.summary()?.coins ?? 0) >= price;
  }

  private async act(key: string, action: () => Promise<RewardsSummary | Bet>): Promise<void> {
    this.busy.set(key);
    this.error.set(null);
    try {
      const result = await action();
      if ("coins" in result) {
        this.latest.set(result);
        this.store.coins.set(result.coins);
      } else {
        this.latest.set(undefined);
        this.data.reload();
      }
    } catch (error) {
      const message = (error as { error?: { error?: string } }).error?.error;
      this.error.set(message ?? "No se pudo completar. Comprueba que el servidor de Nexura sigue en marcha.");
    } finally {
      this.busy.set(null);
    }
  }

  protected buy(item: ShopItem): Promise<void> {
    return this.act(item.id, () => this.api.buyItem(item.id));
  }

  protected equip(slot: ShopSlot, item: ShopItem | null): Promise<void> {
    return this.act(`${slot}:${item?.id ?? ""}`, () => this.api.equipItem(slot, item?.id ?? null));
  }

  protected isEquipped(item: ShopItem): boolean {
    return this.summary()?.equipped[item.kind as ShopSlot] === item.id;
  }

  protected bet(kind: BetKind, run: Run): Promise<void> {
    return this.act(`bet:${kind}:${run.id}`, () => this.api.placeBet(kind, run.id, this.stake()));
  }

  protected setStake(value: string): void {
    const n = Math.round(Number(value));
    this.stake.set(Math.min(BET_LIMITS.max, Math.max(BET_LIMITS.min, Number.isFinite(n) ? n : BET_LIMITS.min)));
  }

  protected runLabel(runId: string): string {
    const run = this.store.runs().find((r) => r.id === runId);
    return run?.request.ticketId ? `#${run.request.ticketId}` : run?.request.ticketText.slice(0, 40) || runId.slice(0, 8);
  }

  protected betOn(run: Run): Bet | undefined {
    return this.summary()?.bets.find((bet) => bet.status === "open" && bet.runId === run.id && bet.kind !== "race");
  }

  protected readonly openRace = computed(() => this.summary()?.bets.find((bet) => bet.status === "open" && bet.kind === "race"));

  protected betText(bet: Bet): string {
    const what = bet.kind === "race" ? "gana el Gran Premio" : bet.kind === "first-try" ? "pasa a la primera" : "vuelve a implementar";
    return `${this.runLabel(bet.runId)} ${what}`;
  }

  protected readonly betStatus: Record<Bet["status"], { label: string; cls: string }> = {
    open: { label: "En juego", cls: "bg-info-soft text-info" },
    won: { label: "Ganada", cls: "bg-ok-soft text-ok" },
    lost: { label: "Perdida", cls: "bg-err-soft text-err" },
    refunded: { label: "Devuelta", cls: "bg-surface-3 text-muted" },
  };
}
