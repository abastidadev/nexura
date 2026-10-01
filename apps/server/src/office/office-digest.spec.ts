import { describe, expect, it } from "vitest";
import type { Run, StepRun } from "@nexura/shared";
import { officeContinue, officeDigest } from "./office-digest.ts";

const NOW = new Date(2026, 9, 1, 15, 0, 0);
const TODAY = new Date(2026, 9, 1, 10, 0, 0).toISOString();

function step(name: string, seq: number, status: StepRun["status"], agent: StepRun["agent"] = "claude"): StepRun {
  return { id: `${name}-${seq}`, runId: "r", step: name, attempt: 1, seq, status, kind: "claude", agent, model: "m", effort: "medium", costUsd: 0, numTurns: 1, finishedAt: TODAY };
}

function run(id: string, extra: Partial<Run>): Run {
  return { id, request: { ticketId: id, ticketText: `Ticket ${id}\nmore`, repos: ["app"], tasks: [], prompt: "", profile: "standard", stepByStep: false }, status: "running", createdAt: TODAY, steps: [], worktrees: [], totalCostUsd: 0.5, ...extra };
}

describe("officeDigest", () => {
  it("shows each running flow's pipeline once per step, what it waits for, and who works", () => {
    const digest = officeDigest({
      runs: [
        run("1", { steps: [step("classify", 0, "succeeded"), step("implement", 1, "succeeded"), step("codeReview", 2, "failed"), step("implement", 3, "running", "codex")] }),
        run("2", { status: "paused", steps: [step("implement", 1, "succeeded")], pendingStep: { step: "release", prDrafts: [{ repo: "app", title: "t", body: "b", sourceBranch: "s", targetBranch: "main" }] as never } }),
        run("3", { status: "done", steps: [step("implement", 1, "succeeded")] }),
      ],
      trophiesToday: ["Primera misión"],
      coinsToday: 40,
      now: NOW,
    });
    expect(digest.active.map((flow) => flow.runId)).toEqual(["1", "2"]);
    expect(digest.active[0]).toMatchObject({ name: "#1", title: "Ticket 1", agent: "codex", current: "implement", steps: [{ step: "implement", status: "running" }, { step: "codeReview", status: "failed" }] });
    expect(digest.active[1]).toMatchObject({ waiting: "pr", current: "release" });
    expect(digest.today).toMatchObject({ flowsDone: 1, trophies: ["Primera misión"], coins: 40, costUsd: 1.5 });
  });

  it("lists merged flows newest first for the Hall of Fame", () => {
    const digest = officeDigest({
      runs: [
        run("a", { status: "done", reviewWatch: { checkedAt: TODAY, activeThreads: 0, prStatus: "completed", mergedAt: "2026-09-01T10:00:00Z" }, pullRequests: [{ repo: "app", id: 4, url: "https://x/4", title: "Login SSO" }] }),
        run("b", { status: "done", reviewWatch: { checkedAt: TODAY, activeThreads: 0, prStatus: "completed", mergedAt: TODAY } }),
        run("c", { status: "done", reviewWatch: { checkedAt: TODAY, activeThreads: 0, prStatus: "active" } }),
      ],
      trophiesToday: [],
      coinsToday: 0,
      now: NOW,
    });
    expect(digest.merged.map((merge) => merge.runId)).toEqual(["b", "a"]);
    expect(digest.merged[1]).toMatchObject({ title: "Login SSO", url: "https://x/4" });
    expect(digest.today.prsMerged).toBe(1);
  });
});

describe("officeContinue", () => {
  it("approves what the run proposes, or skips, and refuses a flow that isn't waiting", () => {
    const drafts = [{ repo: "app" }] as never;
    expect(officeContinue(run("p", { status: "paused", pendingStep: { step: "release", prDrafts: drafts } }), false)).toEqual({ prDrafts: drafts });
    expect(officeContinue(run("p", { status: "paused", pendingStep: { step: "implement" } }), false)).toBeUndefined();
    expect(officeContinue(run("p", { status: "paused", pendingStep: { step: "implement" } }), true)).toEqual({ skip: true });
    expect(() => officeContinue(run("p", {}), false)).toThrow(/no está esperando/);
  });
});
