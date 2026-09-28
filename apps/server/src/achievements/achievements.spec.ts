import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, type PrReviewComment, type Run, type ServerMessage, type StepRun } from "@nexura/shared";
import { AchievementStore } from "./achievement-store.ts";
import { AchievementService } from "./achievement-service.ts";
import { hasRule, isoWeek, longestWorkdayStreak } from "./rules.ts";
import { nextFollowUp } from "./review-follow-up.ts";

function step(runId: string, name: string, status: StepRun["status"], finishedAt: string, agent: StepRun["agent"] = "claude"): StepRun {
  return { id: `${runId}-${name}-${status}`, runId, step: name, attempt: 1, seq: 0, status, kind: "claude", agent, model: "sonnet", effort: "medium", costUsd: 0, numTurns: 1, finishedAt };
}

function flow(id: string, ticketId: string, at: string, extra: Partial<Run> = {}): Run {
  return {
    id,
    request: { ticketId, ticketText: `Ticket ${ticketId}`, repos: ["app"], tasks: [], prompt: "", profile: "standard", stepByStep: false },
    status: "done",
    createdAt: at,
    steps: [step(id, "implement", "succeeded", at)],
    worktrees: [],
    totalCostUsd: 0,
    ...extra,
  };
}

function comment(id: number, severity: PrReviewComment["severity"], file: string, line: number): PrReviewComment {
  return { id, severity, file, startLine: line, endLine: line, title: "t", post: `Problem ${id} here`, why: "", inline: true };
}

function review(id: string, prId: number, at: string, comments: PrReviewComment[] = [comment(1, "major", "src/a.ts", 10)]): Run {
  return {
    id,
    request: {
      ticketText: "",
      repos: ["app"],
      tasks: [],
      prompt: "",
      profile: "",
      stepByStep: false,
      kind: "prReview",
      prReview: { id: prId, title: "PR", author: "ana", sourceBranch: "f", targetBranch: "main", isDraft: false, url: "", headSha: "a1", provider: "github" },
    },
    status: "done",
    createdAt: at,
    steps: [],
    worktrees: [],
    totalCostUsd: 0,
    prReview: { verdict: "approve", summary: "", conventions: [], strengths: [], comments, headSha: "a1", published: { commentIds: comments.map((item) => item.id), at } },
  };
}

function service(): { achievements: AchievementService; won: string[] } {
  const achievements = new AchievementService(new AchievementStore(":memory:"));
  const won: string[] = [];
  achievements.on("message", (message: ServerMessage) => {
    if (message.type === "achievement") {
      won.push(message.achievement.id);
    }
  });
  return { achievements, won };
}

describe("achievement rules", () => {
  it("has a rule for every achievement of the catalog, with unique ids", () => {
    expect(ACHIEVEMENTS.filter((achievement) => !hasRule(achievement.id)).map((achievement) => achievement.id)).toEqual([]);
    expect(new Set(ACHIEVEMENTS.map((achievement) => achievement.id)).size).toBe(ACHIEVEMENTS.length);
  });

  it("counts ISO weeks and streaks of working days across a weekend", () => {
    expect(isoWeek("2026-01-01T12:00:00")).toBe("2026-W01");
    expect(isoWeek("2025-12-29T12:00:00")).toBe("2026-W01");
    // Thursday, Friday, then Monday: three working days in a row.
    expect(longestWorkdayStreak(["2026-09-24", "2026-09-25", "2026-09-28"])).toBe(3);
    expect(longestWorkdayStreak(["2026-09-24", "2026-09-28"])).toBe(1);
  });
});

describe("AchievementService", () => {
  it("unlocks past work silently on sync and announces what comes later", () => {
    const { achievements, won } = service();
    achievements.sync([flow("r1", "1", "2026-09-01T10:00:00Z")]);
    expect(won).toEqual([]);
    const first = achievements.summary().achievements.find((item) => item.id === "first-mission");
    expect(first).toMatchObject({ fresh: true });
    expect(first?.unlockedAt).toBeTruthy();

    for (const [index, day] of ["02", "03", "04", "07"].entries()) {
      achievements.observeRun(flow(`r${index + 2}`, String(index + 2), `2026-09-${day}T10:00:00Z`));
    }
    expect(won).toContain("five-on-board");
    expect(won).not.toContain("first-mission");
  });

  it("needs the weeks as well as the count for spread achievements", () => {
    const { achievements } = service();
    achievements.sync(Array.from({ length: 10 }, (_, index) => flow(`r${index}`, String(index), `2026-09-0${(index % 3) + 1}T10:00:00Z`)));
    const full = achievements.summary().achievements.find((item) => item.id === "full-throttle");
    expect(full?.unlockedAt).toBeUndefined();
    expect(full?.progress).toMatchObject({ current: 10, goal: 10, extra: { goal: 4 } });
  });

  it("does not count reviews of PRs that Nexura's own flows opened", () => {
    const { achievements } = service();
    const own = flow("f1", "9", "2026-09-01T10:00:00Z", { pullRequests: [{ repo: "app", id: 7, url: "", title: "" }] });
    achievements.sync([own, review("rv1", 7, "2026-09-02T10:00:00Z")]);
    expect(achievements.summary().achievements.find((item) => item.id === "sharp-eye")?.unlockedAt).toBeUndefined();
    achievements.observeRun(review("rv2", 8, "2026-09-03T10:00:00Z"));
    expect(achievements.summary().achievements.find((item) => item.id === "sharp-eye")?.unlockedAt).toBeTruthy();
  });

  it("masks locked secrets and reveals them once won", () => {
    const { achievements, won } = service();
    const locked = achievements.summary().achievements.find((item) => item.id === "konami");
    expect(locked).toMatchObject({ title: "Logro secreto", icon: "❔", secret: true });
    expect(locked?.progress).toBeUndefined();
    const unlocked = achievements.office({ kind: "secret", what: "konami" });
    expect(unlocked.map((item) => item.id)).toEqual(["konami"]);
    expect(won).toEqual(["konami"]);
    expect(achievements.summary().achievements.find((item) => item.id === "konami")?.title).toBe("↑↑↓↓←→←→BA");
  });

  it("counts ducks once each and office uses per kind", () => {
    const { achievements } = service();
    achievements.office({ kind: "duck", duck: 2 });
    achievements.office({ kind: "duck", duck: 2 });
    expect(achievements.summary().ducks).toEqual([2]);
    for (let i = 0; i < 10; i++) {
      achievements.office({ kind: "use", what: "dog" });
    }
    expect(achievements.summary().achievements.find((item) => item.id === "good-boy")?.unlockedAt).toBeTruthy();
    expect(() => achievements.office({ kind: "duck", duck: 9 })).toThrow();
    expect(() => achievements.office({ kind: "use", what: "rm -rf" as "dog" })).toThrow();
  });

  it("awards fixed review comments, and the secret when serious ones are merged", () => {
    const { achievements, won } = service();
    const comments = [comment(1, "blocker", "a.ts", 1), comment(2, "major", "b.ts", 2), comment(3, "major", "c.ts", 3), comment(4, "nit", "d.ts", 4)];
    const run = review("rv", 5, "2026-09-02T10:00:00Z", comments);
    run.prReview!.followUp = { checkedAt: "2026-09-03T10:00:00Z", prStatus: "completed", threads: { 1: 11, 2: 12, 3: 13, 4: 14 }, resolvedIds: [1, 2, 3, 4], headMoved: true };
    achievements.observeRun(run);
    expect(won).toContain("before-prod");
    expect(achievements.summary().achievements.find((item) => item.id === "fair-point")?.progress).toMatchObject({ current: 3, goal: 5 });
  });
});

describe("review follow-up", () => {
  it("matches threads on first sight and resolves them once gone after new commits", () => {
    const run = review("rv", 5, "2026-09-02T10:00:00Z", [comment(1, "major", "src/a.ts", 10), comment(2, "minor", "src/b.ts", 20)]);
    const threads = [
      { repo: "app", prId: 5, threadId: 101, filePath: "/src/a.ts", line: 10, comments: [{ author: "me", content: "x" }] },
      { repo: "app", prId: 5, threadId: 102, filePath: "src/b.ts", line: 20, comments: [{ author: "me", content: "y" }] },
    ];
    const first = nextFollowUp(run, undefined, { prStatus: "active", headSha: "a1", threads });
    expect(first).toMatchObject({ threads: { 1: 101, 2: 102 }, resolvedIds: [], headMoved: false });
    const second = nextFollowUp(run, first, { prStatus: "active", headSha: "b2", threads: [threads[1]!] });
    expect(second).toMatchObject({ resolvedIds: [1], headMoved: true });
    const merged = nextFollowUp(run, second, { prStatus: "completed", threads: [] });
    expect(merged.resolvedIds).toEqual([1, 2]);
    expect(merged.mergedAt).toBeTruthy();
  });
});
