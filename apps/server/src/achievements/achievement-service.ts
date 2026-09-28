import { EventEmitter } from "node:events";
import {
  ACHIEVEMENT_TIER_POINTS,
  ACHIEVEMENTS,
  OFFICE_DUCKS,
  OFFICE_USES,
  type AchievementDef,
  type AchievementsSummary,
  type AchievementTier,
  type AchievementView,
  type OfficeAchievementEvent,
  type Run,
  type ServerMessage,
  type TicketDraft,
} from "@nexura/shared";
import { AchievementStore, type Unlock } from "./achievement-store.ts";
import { factsOfDraft, factsOfRun, flowPrKeys, isActiveFlow, prKey } from "./facts.ts";
import { evaluate, isComplete } from "./rules.ts";

const SECRETS = new Set(["konami", "night-shift", "hole-in-one"]);
/** Flows running at once that earn "Multitarea". */
const CONCURRENT_FLOWS = 3;

/** How an achievement shows: a locked secret keeps its title and description to itself. */
function view(def: AchievementDef, unlock: Unlock | undefined, progress: AchievementView["progress"]): AchievementView {
  const hidden = def.secret && !unlock;
  return {
    id: def.id,
    tier: def.tier,
    category: def.category,
    icon: hidden ? "❔" : def.icon,
    title: hidden ? "Logro secreto" : def.title,
    description: hidden ? (def.hint ?? "Sigue explorando.") : def.description,
    secret: Boolean(def.secret),
    ...(unlock ? { unlockedAt: unlock.unlockedAt, ...(unlock.seen ? {} : { fresh: true }) } : {}),
    ...(progress && !hidden ? { progress } : {}),
  };
}

/**
 * Turns what happens in Nexura (runs, reviews, tickets, the 3D office) into trophies. It watches
 * the same messages the UI gets, records facts in its own store and, when an achievement
 * completes, saves it and announces it (`{ type: "achievement" }`) for the trophy toast.
 */
export class AchievementService extends EventEmitter<{ message: [ServerMessage] }> {
  private readonly store: AchievementStore;
  private readonly flowPrs = new Set<string>();
  private readonly active = new Set<string>();

  public constructor(store = new AchievementStore()) {
    super();
    this.store = store;
  }

  /**
   * Catches up with everything that happened before (or while the server was down). Whatever it
   * unlocks is not announced, only marked new for the Logros page.
   */
  public sync(runs: Run[], drafts: TicketDraft[] = []): void {
    for (const key of flowPrKeys(runs)) {
      this.flowPrs.add(key);
    }
    for (const run of runs) {
      if (isActiveFlow(run)) {
        this.active.add(run.id);
      }
      this.record(run);
    }
    for (const draft of drafts) {
      for (const fact of factsOfDraft(draft)) {
        this.store.putFact(fact);
      }
    }
    this.check(false);
  }

  /** A run changed (every persist of the orchestrator). */
  public observeRun(run: Run): void {
    for (const pr of run.pullRequests ?? []) {
      this.flowPrs.add(prKey(pr.repo, pr.id));
    }
    if (isActiveFlow(run)) {
      this.active.add(run.id);
      if (this.active.size >= CONCURRENT_FLOWS) {
        this.store.putFact({ kind: "concurrent", key: String(CONCURRENT_FLOWS), at: new Date().toISOString(), data: { runs: [...this.active] } });
      }
    } else {
      this.active.delete(run.id);
    }
    this.record(run);
    this.check(true);
  }

  public forgetRun(runId: string): void {
    this.active.delete(runId);
  }

  public observeDraft(draft: TicketDraft): void {
    const facts = factsOfDraft(draft);
    for (const fact of facts) {
      this.store.putFact(fact);
    }
    if (facts.length) {
      this.check(true);
    }
  }

  /** Something the user did in the 3D office. Returns what it unlocked, for the office's own toast. */
  public office(event: OfficeAchievementEvent): AchievementView[] {
    const at = new Date().toISOString();
    if (event.kind === "use" && (OFFICE_USES as readonly string[]).includes(event.what)) {
      this.store.bump(`use:${event.what}`);
    } else if (event.kind === "duck" && Number.isInteger(event.duck) && event.duck >= 1 && event.duck <= OFFICE_DUCKS) {
      this.store.putFact({ kind: "duck", key: String(event.duck), at, data: {} });
    } else if (event.kind === "secret" && SECRETS.has(event.what)) {
      this.store.putFact({ kind: "secret", key: event.what, at, data: {} });
    } else {
      throw new Error("Evento de la oficina desconocido");
    }
    return this.check(true);
  }

  public summary(): AchievementsSummary {
    const unlocks = this.store.unlocks();
    const progress = evaluate({ facts: this.store.facts(), counters: this.store.counters(), unlocked: new Set(unlocks.keys()) });
    const achievements = ACHIEVEMENTS.map((def) => view(def, unlocks.get(def.id), progress.get(def.id)));
    const byTier = Object.fromEntries(
      (["bronze", "silver", "gold", "platinum"] as AchievementTier[]).map((tier) => {
        const all = ACHIEVEMENTS.filter((def) => def.tier === tier);
        return [tier, { unlocked: all.filter((def) => unlocks.has(def.id)).length, total: all.length }];
      }),
    ) as AchievementsSummary["byTier"];
    return {
      achievements,
      unlocked: unlocks.size,
      total: ACHIEVEMENTS.length,
      points: ACHIEVEMENTS.filter((def) => unlocks.has(def.id)).reduce((sum, def) => sum + ACHIEVEMENT_TIER_POINTS[def.tier], 0),
      maxPoints: ACHIEVEMENTS.reduce((sum, def) => sum + ACHIEVEMENT_TIER_POINTS[def.tier], 0),
      byTier,
      ducks: this.store.facts().filter((fact) => fact.kind === "duck").map((fact) => Number(fact.key)).sort(),
    };
  }

  /** The Logros page was opened: nothing is new any more. */
  public markSeen(): void {
    this.store.markSeen();
  }

  public close(): void {
    this.store.close();
  }

  private record(run: Run): void {
    for (const fact of factsOfRun(run, this.flowPrs)) {
      this.store.putFact(fact);
    }
  }

  /** Unlocks whatever completed; a second pass lets the platinum follow the gold that completes it. */
  private check(announce: boolean): AchievementView[] {
    const won: AchievementView[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const unlocks = this.store.unlocks();
      const progress = evaluate({ facts: this.store.facts(), counters: this.store.counters(), unlocked: new Set(unlocks.keys()) });
      const fresh = ACHIEVEMENTS.filter((def) => !unlocks.has(def.id) && isComplete(progress.get(def.id)!));
      if (!fresh.length) {
        break;
      }
      const at = new Date().toISOString();
      for (const def of fresh) {
        this.store.unlock(def.id, at, false);
        const shown = view(def, { id: def.id, unlockedAt: at, seen: false }, progress.get(def.id));
        won.push(shown);
        if (announce) {
          this.emit("message", { type: "achievement", achievement: shown });
        }
      }
    }
    return won;
  }
}
