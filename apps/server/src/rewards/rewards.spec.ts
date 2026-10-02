import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COIN_REWARDS,
  COINS_PER_TIER,
  DAILY_GAME_CAP,
  SHOP_ITEM_BY_ID,
  SHOP_OFFERS,
  drawShop,
  duckSeason,
  type Run,
  type ServerMessage,
  type StepRun,
} from "@nexura/shared";
import type { Fact } from "../achievements/achievement-store.ts";
import { RewardService, type WorkSource } from "./reward-service.ts";
import { RewardStore } from "./reward-store.ts";

const NOW = new Date(2026, 9, 1, 12, 0, 0);

function step(name: string, status: StepRun["status"] = "succeeded"): StepRun {
  return { id: `${name}-${status}`, runId: "r", step: name, attempt: 1, seq: 0, status, kind: "claude", agent: "claude", model: "sonnet", effort: "medium", costUsd: 0, numTurns: 1 };
}

function run(id: string, status: Run["status"], steps: StepRun[] = []): Run {
  return { id, request: { ticketId: id, ticketText: "", repos: ["app"], tasks: [], prompt: "", profile: "standard", stepByStep: false }, status, createdAt: NOW.toISOString(), steps, worktrees: [], totalCostUsd: 0 };
}

function source(facts: Fact[] = [], unlocked: ReturnType<WorkSource["unlocked"]> = []): WorkSource {
  return { facts: () => facts, unlocked: () => unlocked };
}

function service(runs: Run[] = [], repos: { name: string; path: string }[] = []) {
  const rewards = new RewardService(new RewardStore(":memory:"), { runs: () => runs, repos: () => repos, now: () => NOW });
  const messages: ServerMessage[] = [];
  rewards.on("message", (message) => messages.push(message));
  return { rewards, messages, runs };
}

/** Owns an item without going through today's shop (which may not have it). */
function unlock(rewards: RewardService, item: string) {
  (rewards as unknown as { store: RewardStore }).store.buy(item, 0, NOW.toISOString(), "test");
}

/** Gives the wallet `coins` by paying a big trophy now and then. */
function fund(rewards: RewardService, coins: number) {
  const unlocked = Array.from({ length: Math.ceil(coins / COINS_PER_TIER.platinum) }, (_, i) => ({ id: `fund-${i}`, tier: "platinum" as const, title: "Fondos", at: NOW.toISOString() }));
  rewards.settle(source([], unlocked), false);
}

describe("the daily shop", () => {
  it("draws the same offers for the same day and different ones another day", () => {
    const owned = new Set<string>();
    expect(drawShop("2026-10-01", owned)).toEqual(drawShop("2026-10-01", owned));
    expect(drawShop("2026-10-01", owned)).not.toEqual(drawShop("2026-10-02", owned));
  });

  it("always brings a room or game while one is locked, one deal, and nothing you already own", () => {
    for (let day = 1; day <= 28; day++) {
      const date = `2026-02-${String(day).padStart(2, "0")}`;
      const owned = new Set(["hat-cap", "hat-beanie", "acc-sunglasses"]);
      const offers = drawShop(date, owned);
      expect(offers).toHaveLength(SHOP_OFFERS);
      expect(new Set(offers.map((o) => o.itemId)).size).toBe(SHOP_OFFERS);
      expect(offers.filter((o) => o.deal)).toHaveLength(1);
      expect(offers.some((o) => ["room", "game"].includes(SHOP_ITEM_BY_ID.get(o.itemId)!.kind))).toBe(true);
      expect(offers.some((o) => owned.has(o.itemId))).toBe(false);
      const deal = offers.find((o) => o.deal)!;
      expect(deal.price).toBeLessThan(SHOP_ITEM_BY_ID.get(deal.itemId)!.price);
    }
  });

  it("keeps today's offers once drawn, even after buying one", () => {
    const { rewards } = service();
    fund(rewards, 3000);
    const before = rewards.summary().shop.offers.map((o) => o.itemId);
    rewards.buy(before[0]!);
    const after = rewards.summary().shop.offers;
    expect(after.map((o) => o.itemId)).toEqual(before);
    expect(after[0]!.owned).toBe(true);
  });

  it("dates the next change at local midnight", () => {
    const { rewards } = service();
    expect(new Date(rewards.summary().shop.nextAt).getTime()).toBe(new Date(2026, 9, 2).getTime());
  });
});

describe("coins for work", () => {
  const facts: Fact[] = [
    { kind: "flow", key: "r1", at: NOW.toISOString(), data: { firstTry: true, ticket: "github:4" } },
    { kind: "flow", key: "r2", at: NOW.toISOString(), data: { firstTry: false } },
    { kind: "merge", key: "r1", at: NOW.toISOString(), data: {} },
    { kind: "review", key: "app#7", at: NOW.toISOString(), data: {} },
    { kind: "created", key: "github:9", at: NOW.toISOString(), data: {} },
    { kind: "duck", key: "1", at: NOW.toISOString(), data: {} },
  ];

  it("pays the history once, quietly, and only what is new afterwards, announced", () => {
    const { rewards, messages } = service();
    const unlocked = [{ id: "first-mission", tier: "bronze" as const, title: "Primera misión", at: NOW.toISOString() }];
    rewards.settle(source(facts, unlocked), false);
    const expected = COIN_REWARDS.welcome + COINS_PER_TIER.bronze + 2 * COIN_REWARDS.flow + COIN_REWARDS.firstTry + COIN_REWARDS.merge + COIN_REWARDS.review + COIN_REWARDS.ticketCreated;
    expect(rewards.summary().coins).toBe(expected);
    expect(messages).toEqual([]);
    rewards.settle(source(facts, unlocked), true);
    expect(rewards.summary().coins).toBe(expected);
    rewards.settle(source([...facts, { kind: "merge", key: "r2", at: NOW.toISOString(), data: {} }], unlocked), true);
    expect(rewards.summary().coins).toBe(expected + COIN_REWARDS.merge);
    expect(messages).toEqual([{ type: "coins", delta: COIN_REWARDS.merge, balance: expected + COIN_REWARDS.merge, reason: "PR de un flujo integrada" }]);
  });
});

describe("buying and wearing", () => {
  it("refuses what is not in today's shop, what you can't pay, and what you own", () => {
    const { rewards } = service();
    rewards.settle(source(), false);
    const offers = rewards.summary().shop.offers;
    const missing = [...SHOP_ITEM_BY_ID.keys()].find((id) => !offers.some((o) => o.itemId === id))!;
    expect(() => rewards.buy(missing)).toThrow(/no está hoy/);
    const priciest = [...offers].sort((a, b) => b.price - a.price)[0]!;
    expect(() => rewards.buy(priciest.itemId)).toThrow(/Te faltan/);
    expect(rewards.summary().coins).toBe(COIN_REWARDS.welcome);
    fund(rewards, 2000);
    rewards.buy(priciest.itemId);
    expect(() => rewards.buy(priciest.itemId)).toThrow(/Ya tienes/);
  });

  it("puts a cosmetic on when bought into a free slot, and only lets you wear what you own", () => {
    const { rewards } = service();
    fund(rewards, 5000);
    const offers = rewards.summary().shop.offers;
    const cosmetic = offers.find((o) => !["room", "game"].includes(SHOP_ITEM_BY_ID.get(o.itemId)!.kind))!;
    const item = SHOP_ITEM_BY_ID.get(cosmetic.itemId)!;
    const summary = rewards.buy(item.id);
    expect(summary.equipped[item.kind as "hat"]).toBe(item.id);
    expect(rewards.equip(item.kind as "hat", null).equipped[item.kind as "hat"]).toBeUndefined();
    const other = [...SHOP_ITEM_BY_ID.values()].find((i) => i.kind === item.kind && i.id !== item.id)!;
    expect(() => rewards.equip(item.kind as "hat", other.id)).toThrow(/Aún no tienes/);
    expect(() => rewards.equip("hat", "pet-cat")).toThrow(/no va en ese hueco/);
  });
});

describe("bets", () => {
  it("doubles a right porra, keeps a wrong one, and refunds a flow that never finished", () => {
    const runs = [run("a", "running", [step("implement")]), run("b", "running"), run("c", "running")];
    const { rewards } = service(runs);
    fund(rewards, 500);
    const start = rewards.summary().coins;
    const won = rewards.bet({ kind: "first-try", runId: "a", stake: 50 });
    rewards.bet({ kind: "retry", runId: "b", stake: 20 });
    rewards.bet({ kind: "first-try", runId: "c", stake: 30 });
    expect(() => rewards.bet({ kind: "retry", runId: "a", stake: 10 })).toThrow(/Ya has apostado/);
    expect(rewards.summary().coins).toBe(start - 100);
    rewards.observeRun(run("a", "done", [step("implement"), step("qaCode")]));
    rewards.observeRun(run("b", "done", [step("implement"), step("qaCode")]));
    rewards.observeRun(run("c", "failed", [step("implement", "failed")]));
    expect(rewards.summary().coins).toBe(start - 100 + 100 + 30);
    expect(rewards.summary().bets.find((b) => b.id === won.id)?.status).toBe("won");
  });

  it("closes the porra once the flow reaches review or QA", () => {
    const { rewards } = service([run("a", "running", [step("implement"), step("codeReview")])]);
    fund(rewards, 100);
    expect(() => rewards.bet({ kind: "first-try", runId: "a", stake: 10 })).toThrow(/cerrada/);
  });

  it("runs the Grand Prix only when unlocked and with two flows, and pays the stake times the field", () => {
    const runs = [run("a", "running"), run("b", "running"), run("c", "running")];
    const { rewards } = service(runs);
    fund(rewards, 3000);
    expect(() => rewards.bet({ kind: "race", runId: "a", stake: 10 })).toThrow(/bloqueado/);
    unlock(rewards, "game-race");
    const before = rewards.summary().coins;
    rewards.bet({ kind: "race", runId: "b", stake: 40 });
    rewards.observeRun(run("a", "failed"));
    rewards.observeRun(run("b", "done"));
    expect(rewards.summary().coins).toBe(before - 40 + 120);
  });
});

describe("the office", () => {
  it("pays the daily visit once a day", () => {
    const { rewards } = service();
    expect(rewards.office({ kind: "visit" }).paid).toBe(COIN_REWARDS.dailyVisit);
    expect(rewards.office({ kind: "visit" }).paid).toBe(0);
  });

  it("pays each duck of this week's season once, and a bonus for all five", () => {
    const { rewards } = service();
    const season = duckSeason(NOW);
    expect(() => rewards.office({ kind: "duck", duck: 1, season: "2020-W01" })).toThrow(/temporada/);
    for (const duck of [1, 2, 3, 4]) expect(rewards.office({ kind: "duck", duck, season }).paid).toBe(COIN_REWARDS.duck);
    expect(rewards.office({ kind: "duck", duck: 4, season }).paid).toBe(0);
    expect(rewards.office({ kind: "duck", duck: 5, season }).paid).toBe(COIN_REWARDS.duck + COIN_REWARDS.duckSeason);
    expect(rewards.summary().ducks).toEqual({ season, found: [1, 2, 3, 4, 5] });
  });

  it("keeps the futbolín locked until bought, and caps what it pays a day", () => {
    const { rewards } = service();
    expect(() => rewards.office({ kind: "game", game: "futbolin", result: "win" })).toThrow(/bloqueado/);
    unlock(rewards, "game-futbolin");
    expect(rewards.office({ kind: "game", game: "futbolin", result: "loss" }).paid).toBe(0);
    const paid = Array.from({ length: 6 }, () => rewards.office({ kind: "game", game: "futbolin", result: "win" }).paid);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(DAILY_GAME_CAP.futbolin);
  });
});

describe("the trivia", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("asks about a repo's history and pays a right answer", async () => {
    dir = mkdtempSync(join(tmpdir(), "nexura-trivia-"));
    const env = { ...process.env, GIT_AUTHOR_DATE: "2024-05-01T10:00:00", GIT_COMMITTER_DATE: "2024-05-01T10:00:00" };
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [who, file, msg] of [["Ana", "a.ts", "feat: add login form"], ["Luis", "b.ts", "fix: handle empty token"], ["Ana", "a.ts", "refactor: split the router"], ["Eva", "c.ts", "docs: explain the deploy"]]) {
      writeFileSync(join(dir, file!), `${msg}\n${Math.random()}`);
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", `user.name=${who}`, "-c", "user.email=x@y.z", "commit", "-q", "-m", msg!], { cwd: dir, env });
    }
    const { rewards } = service([], [{ name: "app", path: dir }]);
    await expect(rewards.triviaQuestion()).rejects.toThrow(/bloqueado/);
    fund(rewards, 3000);
    unlock(rewards, "game-trivia");
    const question = await rewards.triviaQuestion();
    expect(question.repo).toBe("app");
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    const card = (rewards as unknown as { trivia: Map<string, { card: { answer: string } }> }).trivia.get(question.id)!.card;
    const answer = rewards.triviaAnswer(question.id, card.answer);
    expect(answer).toMatchObject({ correct: true, coins: COIN_REWARDS.triviaCorrect });
    expect(() => rewards.triviaAnswer(question.id, card.answer)).toThrow(/caducó/);
    expect(DAILY_GAME_CAP.trivia % COIN_REWARDS.triviaCorrect).toBe(0);
  });
});
