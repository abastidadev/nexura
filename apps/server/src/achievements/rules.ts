import { ACHIEVEMENTS, OFFICE_DUCKS, OFFICE_USES, type AchievementProgress } from "@nexura/shared";
import type { Fact } from "./achievement-store.ts";
import type { FixedFact, FlowFact, MergeFact, ReviewFact } from "./facts.ts";

/** Everything the rules read: facts, the office's counters, and the achievements already won. */
export type RuleInput = { facts: Fact[]; counters: Map<string, number>; unlocked: ReadonlySet<string> };

type Rule = (input: Indexed) => AchievementProgress;

/** Facts grouped by kind, once per evaluation. */
type Indexed = RuleInput & { of<T = Record<string, unknown>>(kind: string): Fact<T>[] };

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar day, YYYY-MM-DD (Nexura runs on the user's machine: its clock is theirs). */
export function localDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO week of a local date, e.g. 2026-W40. */
export function isoWeek(iso: string): string {
  const source = new Date(iso);
  const date = new Date(Date.UTC(source.getFullYear(), source.getMonth(), source.getDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function weeks(facts: Fact[]): number {
  return new Set(facts.map((fact) => isoWeek(fact.at))).size;
}

/** The longest run of working days in a row (a Friday is followed by the Monday) with something done. */
export function longestWorkdayStreak(days: string[]): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let current = 0;
  let previous: Date | undefined;
  for (const day of sorted) {
    const date = new Date(`${day}T12:00:00`);
    if (date.getDay() === 0 || date.getDay() === 6) {
      continue; // Weekend work neither breaks nor extends a streak.
    }
    const expected = previous ? nextWorkday(previous) : undefined;
    current = expected?.toDateString() === date.toDateString() ? current + 1 : 1;
    best = Math.max(best, current);
    previous = date;
  }
  return best;
}

function nextWorkday(date: Date): Date {
  const next = new Date(date);
  do {
    next.setDate(next.getDate() + 1);
  } while (next.getDay() === 0 || next.getDay() === 6);
  return next;
}

const count = (current: number, goal: number): AchievementProgress => ({ current: Math.min(current, goal), goal });

/** `n` items spread over at least `w` distinct weeks. */
function spread(facts: Fact[], goal: number, weekGoal: number): AchievementProgress {
  return { current: Math.min(facts.length, goal), goal, extra: { current: Math.min(weeks(facts), weekGoal), goal: weekGoal, label: "semanas" } };
}

const hour = (iso: string): number => new Date(iso).getHours();

const RULES: Record<string, Rule> = {
  "first-mission": (x) => count(x.of("ticket").length, 1),
  "five-on-board": (x) => count(x.of("ticket").length, 5),
  "first-merge": (x) => count(x.of("merge").length, 1),
  "back-to-workshop": (x) => count(x.of<MergeFact>("merge").filter((fact) => fact.data.addressed).length, 1),
  "ticket-writer": (x) => count(x.of("created").length, 1),
  multitask: (x) => count(x.of("concurrent").length, 1),
  "two-fronts": (x) => count(x.of<FlowFact>("flow").filter((fact) => fact.data.ticket && fact.data.repos > 1).length, 1),
  "full-throttle": (x) => spread(x.of("ticket"), 10, 4),
  "first-try": (x) => count(new Set(x.of<FlowFact>("flow").filter((fact) => fact.data.firstTry && fact.data.ticket).map((fact) => fact.data.ticket)).size, 10),
  polyglot: (x) => count(new Set(x.of<FlowFact>("flow").flatMap((fact) => fact.data.agents)).size, 3),
  "board-veteran": (x) => spread(x.of("ticket"), 50, 12),

  "sharp-eye": (x) => count(x.of("review").length, 1),
  constructive: (x) => count(x.of<ReviewFact>("review").filter((fact) => fact.data.comments >= 3 && fact.data.suggestions >= 1).length, 1),
  "second-pair": (x) => spread(x.of("review"), 20, 6),
  "fair-point": (x) => count(x.of("fixed").length, 5),
  "note-taker": (x) => count(x.of("conventions").length, 3),
  "code-guardian": (x) => spread(x.of("review"), 60, 12),
  "real-bug": (x) => count(x.of("fixed").length, 20),

  "on-a-roll": (x) => count(longestWorkdayStreak([...x.of("ticket"), ...x.of("review")].map((fact) => localDay(fact.at))), 3),
  "always-here": (x) => count(weeks([...x.of("ticket"), ...x.of("review")]), 8),
  "all-terrain": (x) => {
    const tickets = x.of("ticket");
    const reviews = x.of("review");
    return {
      current: Math.min(tickets.length, 20) + Math.min(reviews.length, 20),
      goal: 40,
      extra: { current: Math.min(weeks([...tickets, ...reviews]), 12), goal: 12, label: "semanas" },
    };
  },
  "half-year": (x) => count(weeks([...x.of("ticket"), ...x.of("review")]), 26),

  "before-prod": (x) => count(x.of<FixedFact>("fixed").filter((fact) => fact.data.merged && (fact.data.severity === "blocker" || fact.data.severity === "major")).length, 3),
  "full-chain": (x) => {
    const created = new Set(x.of("created").map((fact) => fact.key));
    return count(new Set(x.of<MergeFact>("merge").filter((fact) => fact.data.ticket && created.has(fact.data.ticket) && fact.data.reviewedByOthers).map((fact) => fact.data.ticket)).size, 5);
  },
  "night-owl": (x) => count(x.of("flow").filter((fact) => hour(fact.at) < 5).length, 1),
  "friday-deploy": (x) => count(x.of("merge").filter((fact) => new Date(fact.at).getDay() === 5 && hour(fact.at) >= 15).length, 1),
  phoenix: (x) => count(x.of<FlowFact>("flow").filter((fact) => fact.data.recovered).length, 1),

  "trophy-room": (x) => count(x.counters.get("use:trophies") ?? 0, 1),
  "good-boy": (x) => count(x.counters.get("use:dog") ?? 0, 10),
  caffeine: (x) => count(x.counters.get("use:coffee") ?? 0, 10),
  gong: (x) => count(x.counters.get("use:gong") ?? 0, 1),
  dj: (x) => count(x.counters.get("use:jukebox") ?? 0, 1),
  "insert-coin": (x) => count(x.counters.get("use:cabinet") ?? 0, 3),
  firefighter: (x) => count(x.counters.get("use:pole") ?? 0, 1),
  tourist: (x) => count(OFFICE_USES.filter((use) => (x.counters.get(`use:${use}`) ?? 0) > 0).length, 12),
  "duck-1": (x) => count(x.of("duck").length, 1),
  "duck-hunter": (x) => count(x.of("duck").length, OFFICE_DUCKS),
  rooftop: (x) => count(Number((x.counters.get("use:ladder") ?? 0) > 0) + Number((x.counters.get("use:bar") ?? 0) > 0), 2),
  "hole-in-one": (x) => count(x.of("secret").filter((fact) => fact.key === "hole-in-one").length, 1),
  "night-shift": (x) => count(x.of("secret").filter((fact) => fact.key === "night-shift").length, 1),
  konami: (x) => count(x.of("secret").filter((fact) => fact.key === "konami").length, 1),

  "nexura-legend": (x) => {
    const golds = ACHIEVEMENTS.filter((achievement) => achievement.tier === "gold");
    return count(golds.filter((achievement) => x.unlocked.has(achievement.id)).length, golds.length);
  },
};

export function isComplete(progress: AchievementProgress): boolean {
  return progress.current >= progress.goal && (!progress.extra || progress.extra.current >= progress.extra.goal);
}

/** Progress of every achievement, by id. */
export function evaluate(input: RuleInput): Map<string, AchievementProgress> {
  const byKind = new Map<string, Fact[]>();
  for (const fact of input.facts) {
    byKind.set(fact.kind, [...(byKind.get(fact.kind) ?? []), fact]);
  }
  const indexed: Indexed = { ...input, of: <T = Record<string, unknown>>(kind: string) => (byKind.get(kind) ?? []) as Fact<T>[] };
  return new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, RULES[achievement.id]?.(indexed) ?? { current: 0, goal: 1 }]));
}

/** Every achievement of the catalog has a rule (checked by the tests). */
export function hasRule(id: string): boolean {
  return id in RULES;
}
