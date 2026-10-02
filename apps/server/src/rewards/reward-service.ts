import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  BET_LIMITS,
  COIN_REWARDS,
  COINS_PER_TIER,
  DAILY_GAME_CAP,
  OFFICE_DUCKS,
  SHOP_ITEM_BY_ID,
  SHOP_ITEMS,
  SHOP_SLOTS,
  drawShop,
  duckSeason,
  isCosmetic,
  shopDay,
  type AchievementTier,
  type Bet,
  type BetKind,
  type OfficeRewardEvent,
  type RewardsSummary,
  type Run,
  type ServerMessage,
  type ShopSlot,
  type TriviaAnswer,
  type TriviaQuestion,
} from "@nexura/shared";
import type { Fact } from "../achievements/achievement-store.ts";
import { RewardStore } from "./reward-store.ts";
import { makeTrivia, type TriviaCard } from "./trivia.ts";

/** An error with the HTTP status the API should answer with (402: not enough coins). */
export class RewardError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Where the coins for work come from: what the trophies recorded (apps/server/src/achievements). */
export type WorkSource = {
  facts(): Fact[];
  unlocked(): { id: string; tier: AchievementTier; title: string; at: string }[];
};

export type RewardDeps = {
  /** The runs Nexura knows, for bets. */
  runs(): Run[];
  /** Configured repos, for the trivia. */
  repos(): { name: string; path: string }[];
  now?: () => Date;
};

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);
/** Steps after which the porra is closed: by then whether it went back to implement is nearly known. */
const LATE_STEPS = new Set(["codeReview", "qaCode", "release"]);
const TRIVIA_TTL_MS = 10 * 60 * 1000;

function isActiveFlow(run: Run): boolean {
  return run.request.kind !== "prReview" && ACTIVE.has(run.status);
}

function runName(run: Run | undefined, id: string): string {
  return run?.request.ticketId ? `#${run.request.ticketId}` : `flujo ${id.slice(0, 8)}`;
}

/** Local midnight of `now`, as an ISO string. */
function midnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Coins, the daily shop and bets. Work pays through the facts the trophies already record (a flow
 * done, a PR merged, a review published, a trophy won), so coins never need tokens either; the 3D
 * office pays for visits, ducks and games. Every movement has a unique key, so nothing pays twice.
 */
export class RewardService extends EventEmitter<{ message: [ServerMessage] }> {
  private readonly store: RewardStore;
  private readonly deps: RewardDeps;
  private readonly trivia = new Map<string, { card: TriviaCard; at: number }>();
  /** Keys already in the wallet: settling runs on every run update, and most of it is already paid. */
  private readonly paid: Set<string>;

  public constructor(store = new RewardStore(), deps: RewardDeps = { runs: () => [], repos: () => [] }) {
    super();
    this.store = store;
    this.deps = deps;
    this.paid = new Set(store.keys(""));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Pays `amount` under `key` once; announces it when `announce`. */
  private pay(key: string, amount: number, reason: string, announce: boolean, at = this.now().toISOString()): boolean {
    if (!amount || this.paid.has(key)) {
      return false;
    }
    this.paid.add(key);
    if (!this.store.add({ key, at, amount, reason })) {
      return false;
    }
    if (announce) {
      this.emit("message", { type: "coins", delta: amount, balance: this.store.balance(), reason });
    }
    return true;
  }

  /**
   * Pays for everything the trophies recorded that hasn't been paid yet. On the first sync it pays
   * the user's history (quietly); after that, each new thing is announced.
   */
  public settle(source: WorkSource, announce: boolean): void {
    this.pay("welcome", COIN_REWARDS.welcome, "Bienvenida a la tienda de Nexura", announce);
    for (const unlock of source.unlocked()) {
      this.pay(`ach:${unlock.id}`, COINS_PER_TIER[unlock.tier], `Logro: ${unlock.title}`, announce);
    }
    for (const fact of source.facts()) {
      const data = fact.data as Record<string, unknown>;
      if (fact.kind === "flow") {
        this.pay(`flow:${fact.key}`, COIN_REWARDS.flow, `Flujo terminado${data.ticket ? ` (${String(data.ticket).split(":").pop()})` : ""}`, announce);
        if (data.firstTry) {
          this.pay(`firsttry:${fact.key}`, COIN_REWARDS.firstTry, "Flujo a la primera", announce);
        }
      } else if (fact.kind === "merge") {
        this.pay(`merge:${fact.key}`, COIN_REWARDS.merge, "PR de un flujo integrada", announce);
      } else if (fact.kind === "review") {
        this.pay(`review:${fact.key}`, COIN_REWARDS.review, `Revisión publicada (${fact.key})`, announce);
      } else if (fact.kind === "created") {
        this.pay(`created:${fact.key}`, COIN_REWARDS.ticketCreated, "Ticket creado con el asistente", announce);
      }
    }
  }

  /** A run changed: settles the bets on it. */
  public observeRun(run: Run): void {
    for (const bet of this.store.bets().filter((b) => b.status === "open")) {
      if (bet.kind === "race") {
        this.settleRace(bet, run);
      } else if (bet.runId === run.id) {
        this.settlePorra(bet, run);
      }
    }
  }

  private closeBet(bet: Bet, status: Bet["status"], payout: number, reason: string): void {
    const settled: Bet = { ...bet, status, settledAt: this.now().toISOString(), ...(payout ? { payout } : {}) };
    this.store.saveBet(settled);
    if (payout) {
      this.pay(`payout:${bet.id}`, payout, reason, true);
    }
  }

  private settlePorra(bet: Bet, run: Run): void {
    if (ACTIVE.has(run.status)) return;
    if (run.status !== "done") {
      this.closeBet(bet, "refunded", bet.stake, `Porra anulada: ${runName(run, run.id)} no terminó`);
      return;
    }
    const implementations = run.steps.filter((step) => step.step === "implement" && step.status === "succeeded").length;
    const firstTry = implementations <= 1;
    const won = (bet.kind === "first-try") === firstTry;
    this.closeBet(bet, won ? "won" : "lost", won ? bet.stake * 2 : 0, `Porra ganada: ${runName(run, run.id)}`);
  }

  private settleRace(bet: Bet, changed: Run): void {
    const field = bet.field ?? [];
    if (!field.includes(changed.id)) return;
    if (changed.status === "done") {
      // The first runner seen finishing wins the race.
      const won = changed.id === bet.runId;
      this.closeBet(bet, won ? "won" : "lost", won ? bet.stake * field.length : 0, `Gran Premio ganado: ${runName(changed, changed.id)}`);
      return;
    }
    const runs = new Map(this.deps.runs().map((run) => [run.id, run]));
    runs.set(changed.id, changed);
    if (field.every((id) => { const run = runs.get(id); return !run || !ACTIVE.has(run.status); })) {
      this.closeBet(bet, "refunded", bet.stake, "Gran Premio anulado: ningún flujo llegó a la meta");
    }
  }

  /** Something done in the 3D office that pays. Returns the coins it paid. */
  public office(event: OfficeRewardEvent): { paid: number } {
    const now = this.now();
    const day = shopDay(now);
    if (event.kind === "visit") {
      return { paid: this.pay(`visit:${day}`, COIN_REWARDS.dailyVisit, "Visita diaria a la Oficina 3D", true) ? COIN_REWARDS.dailyVisit : 0 };
    }
    if (event.kind === "duck") {
      const season = duckSeason(now);
      if (event.season !== season || !Number.isInteger(event.duck) || event.duck < 1 || event.duck > OFFICE_DUCKS) {
        throw new RewardError(400, "Ese patito no es de esta temporada");
      }
      let paid = this.pay(`duck:${season}:${event.duck}`, COIN_REWARDS.duck, `Patito ${event.duck} de la temporada ${season}`, true) ? COIN_REWARDS.duck : 0;
      if (this.store.keys(`duck:${season}:`).length >= OFFICE_DUCKS && this.pay(`ducks:${season}`, COIN_REWARDS.duckSeason, `Los ${OFFICE_DUCKS} patitos de la temporada ${season}`, true)) {
        paid += COIN_REWARDS.duckSeason;
      }
      return { paid };
    }
    if (event.kind === "game" && event.game === "futbolin") {
      if (!this.owns("game-futbolin")) throw new RewardError(403, "El futbolín está bloqueado: cómpralo en la tienda");
      if (event.result !== "win") return { paid: 0 };
      const today = this.store.earnedSince(midnight(now).toISOString(), `futbolin:${day}:`);
      if (today + COIN_REWARDS.futbolinWin > DAILY_GAME_CAP.futbolin) return { paid: 0 };
      const n = this.store.keys(`futbolin:${day}:`).length + 1;
      return { paid: this.pay(`futbolin:${day}:${n}`, COIN_REWARDS.futbolinWin, "Victoria en el futbolín", true) ? COIN_REWARDS.futbolinWin : 0 };
    }
    throw new RewardError(400, "Evento de la oficina desconocido");
  }

  public owns(itemId: string): boolean {
    return this.store.owned().has(itemId);
  }

  private offers(now: Date) {
    const day = shopDay(now);
    return { day, offers: this.store.shopDay(day, () => drawShop(day, this.store.owned())) };
  }

  public summary(): RewardsSummary {
    const now = this.now();
    const owned = this.store.owned();
    const { day, offers } = this.offers(now);
    const tomorrow = midnight(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const season = duckSeason(now);
    return {
      coins: this.store.balance(),
      earnedToday: this.store.earnedSince(midnight(now).toISOString()),
      history: this.store.history(30),
      owned: [...owned],
      equipped: this.store.equipped(),
      shop: { day, nextAt: tomorrow.toISOString(), offers: offers.map((offer) => ({ ...offer, owned: owned.has(offer.itemId) })) },
      bets: this.store.bets().slice(0, 30),
      ducks: { season, found: this.store.keys(`duck:${season}:`).map((key) => Number(key.split(":").pop())).sort() },
      catalog: SHOP_ITEMS,
    };
  }

  /** Buys one of today's offers. */
  public buy(itemId: string): RewardsSummary {
    const item = SHOP_ITEM_BY_ID.get(itemId);
    if (!item) throw new RewardError(404, `No existe el artículo ${itemId}`);
    const offer = this.offers(this.now()).offers.find((o) => o.itemId === itemId);
    if (!offer) throw new RewardError(409, `${item.name} no está hoy en la tienda`);
    if (this.owns(itemId)) throw new RewardError(409, `Ya tienes ${item.name}`);
    if (!this.store.buy(itemId, offer.price, this.now().toISOString(), `Compra: ${item.icon} ${item.name}`)) {
      throw new RewardError(402, `Te faltan ${offer.price - this.store.balance()} monedas para ${item.name}`);
    }
    this.emit("message", { type: "coins", delta: -offer.price, balance: this.store.balance(), reason: `Compra: ${item.icon} ${item.name}` });
    // A cosmetic goes on as soon as it's bought, if its slot is free.
    if (isCosmetic(item) && !this.store.equipped()[item.kind]) this.store.equip(item.kind, itemId);
    return this.summary();
  }

  public equip(slot: ShopSlot, itemId: string | null): RewardsSummary {
    if (!SHOP_SLOTS.includes(slot)) throw new RewardError(400, `Hueco desconocido: ${slot}`);
    if (itemId !== null) {
      const item = SHOP_ITEM_BY_ID.get(itemId);
      if (!item || item.kind !== slot) throw new RewardError(400, "Ese artículo no va en ese hueco");
      if (!this.owns(itemId)) throw new RewardError(403, `Aún no tienes ${item.name}`);
    }
    this.store.equip(slot, itemId);
    return this.summary();
  }

  /** Bets on a flow: the porra (will it pass first try?) or the Grand Prix (which one finishes first). */
  public bet(input: { kind: BetKind; runId: string; stake: number }): Bet {
    const stake = Math.floor(Number(input.stake));
    if (!Number.isFinite(stake) || stake < BET_LIMITS.min || stake > BET_LIMITS.max) {
      throw new RewardError(400, `La apuesta va de ${BET_LIMITS.min} a ${BET_LIMITS.max} monedas`);
    }
    const runs = this.deps.runs();
    const run = runs.find((r) => r.id === input.runId);
    if (!run || !isActiveFlow(run)) throw new RewardError(409, "Solo se apuesta por flujos en marcha");
    const open = this.store.bets().filter((b) => b.status === "open");
    let field: string[] | undefined;
    if (input.kind === "race") {
      if (!this.owns("game-race")) throw new RewardError(403, "El Gran Premio está bloqueado: cómpralo en la tienda");
      field = runs.filter(isActiveFlow).map((r) => r.id);
      if (field.length < 2) throw new RewardError(409, "Hacen falta al menos dos flujos en marcha para una carrera");
      if (open.some((b) => b.kind === "race")) throw new RewardError(409, "Ya tienes una apuesta en la carrera en curso");
    } else if (input.kind === "first-try" || input.kind === "retry") {
      if (run.steps.some((step) => LATE_STEPS.has(step.step))) throw new RewardError(409, "La porra de este flujo ya está cerrada: ya pasó a revisión o QA");
      if (open.some((b) => b.runId === run.id && b.kind !== "race")) throw new RewardError(409, "Ya has apostado por este flujo");
    } else {
      throw new RewardError(400, "Tipo de apuesta desconocido");
    }
    const bet: Bet = { id: randomUUID(), kind: input.kind, runId: run.id, ...(field ? { field } : {}), stake, placedAt: this.now().toISOString(), status: "open" };
    const what = input.kind === "race" ? `Gran Premio: ${runName(run, run.id)}` : `Porra: ${runName(run, run.id)} ${input.kind === "first-try" ? "a la primera" : "vuelve a implementar"}`;
    if (!this.store.placeBet(bet, what)) throw new RewardError(402, `No tienes ${stake} monedas`);
    this.emit("message", { type: "coins", delta: -stake, balance: this.store.balance(), reason: what });
    return bet;
  }

  /** A new trivia question (the Trivial del repo game). */
  public async triviaQuestion(): Promise<TriviaQuestion> {
    if (!this.owns("game-trivia")) throw new RewardError(403, "El Trivial está bloqueado: cómpralo en la tienda");
    const made = await makeTrivia(this.deps.repos());
    if (!made) throw new RewardError(409, "Tus repos aún no tienen historia suficiente para preguntas");
    const now = Date.now();
    for (const [id, entry] of this.trivia) if (now - entry.at > TRIVIA_TTL_MS) this.trivia.delete(id);
    this.trivia.set(made.question.id, { card: made, at: now });
    return made.question;
  }

  public triviaAnswer(id: string, option: string): TriviaAnswer {
    const entry = this.trivia.get(id);
    if (!entry) throw new RewardError(410, "Esa pregunta ya caducó");
    this.trivia.delete(id);
    const now = this.now();
    const day = shopDay(now);
    const correct = entry.card.answer === option;
    const earned = this.store.earnedSince(midnight(now).toISOString(), `trivia:${day}:`);
    let coins = 0;
    if (correct && earned + COIN_REWARDS.triviaCorrect <= DAILY_GAME_CAP.trivia) {
      coins = this.pay(`trivia:${day}:${id}`, COIN_REWARDS.triviaCorrect, "Acierto en el Trivial del repo", true) ? COIN_REWARDS.triviaCorrect : 0;
    }
    return { correct, answer: entry.card.answer, coins, earnedToday: earned + coins };
  }

  public close(): void {
    this.store.close();
  }
}
