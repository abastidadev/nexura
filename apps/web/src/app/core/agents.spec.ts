import { describe, expect, it } from "vitest";
import type { FlowProfile, NexuraEvent, Run, StepRun } from "@nexura/shared";
import { activityFor, buildRunAgents, countWorking, plannedSteps, type AgentConfig, type AgentEvent } from "./agents";

const profile: FlowProfile = {
  name: "standard",
  description: "",
  maxLoops: 2,
  steps: {
    enrich: { model: "haiku", effort: "medium", enabled: true },
    plan: { model: "sonnet", effort: "medium", enabled: true },
    implement: { model: "opus", effort: "high", enabled: true },
    codeReview: { model: "sonnet", effort: "medium", enabled: false },
    qaCode: { model: "haiku", effort: "low", enabled: true },
  },
};

const config: AgentConfig = {
  profiles: [profile],
  steps: [
    { name: "classify", kind: "claude" },
    { name: "enrich", kind: "claude" },
    { name: "plan", kind: "claude" },
    { name: "implement", kind: "claude" },
    { name: "codeReview", kind: "claude" },
    { name: "qaCode", kind: "builtin" },
    { name: "docs", kind: "claude", custom: true, after: "implement" },
  ],
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run1",
    request: { ticketText: "Badge", repos: ["sandbox"], tasks: [], prompt: "", profile: "auto", stepByStep: false },
    status: "running",
    resolvedProfile: "standard",
    createdAt: "2026-09-24T10:00:00.000Z",
    steps: [],
    worktrees: [],
    totalCostUsd: 0,
    ...overrides,
  };
}

function step(name: string, status: StepRun["status"], overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: `sr-${name}`,
    runId: "run1",
    step: name,
    attempt: 1,
    seq: 1,
    status,
    kind: "claude",
    model: "sonnet",
    effort: "medium",
    costUsd: 0.02,
    numTurns: 3,
    startedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-09-24T10:05:00.000Z");
const at = (second: number): string => new Date(Date.parse("2026-09-24T10:04:00.000Z") + second * 1000).toISOString();
const ev = (second: number, event: NexuraEvent): AgentEvent => ({ ts: at(second), event });
const use = (id: string, name: string, input: unknown, parent: string | null = null): NexuraEvent => ({ kind: "toolUse", id, name, input, parentToolUseId: parent });
const result = (id: string, parent: string | null = null, isError = false): NexuraEvent => ({
  kind: "toolResult",
  toolUseId: id,
  content: isError ? "boom" : "ok",
  isError,
  parentToolUseId: parent,
});

describe("plannedSteps", () => {
  it("lists classify (auto) and the enabled profile steps in pipeline order, custom ones included", () => {
    const withCustom: AgentConfig = { ...config, profiles: [{ ...profile, steps: { ...profile.steps, docs: { model: "haiku", effort: "low", enabled: true } } }] };
    const planned = plannedSteps(makeRun(), withCustom);
    expect(planned.map((plan) => plan.name)).toEqual(["classify", "enrich", "plan", "implement", "docs", "qaCode"]);
    expect(planned.find((plan) => plan.name === "qaCode")).toMatchObject({ builtin: true, detail: "sin LLM", model: undefined });
    expect(planned.find((plan) => plan.name === "implement")).toMatchObject({ model: "opus", detail: "opus/high" });
  });

  it("is empty without config", () => {
    expect(plannedSteps(makeRun(), null)).toEqual([]);
  });
});

describe("activityFor", () => {
  it("maps tools and events to what the character does", () => {
    expect(activityFor(use("1", "Grep", {}))).toBe("reading");
    expect(activityFor(use("1", "Read", {}))).toBe("reading");
    expect(activityFor(use("1", "Edit", {}))).toBe("typing");
    expect(activityFor(use("1", "Write", {}))).toBe("typing");
    expect(activityFor(use("1", "Bash", {}))).toBe("running");
    expect(activityFor(use("1", "Agent", {}))).toBe("delegating");
    expect(activityFor(use("1", "Task", {}))).toBe("delegating");
    expect(activityFor({ kind: "thinking", text: "" })).toBe("thinking");
    expect(activityFor({ kind: "text", text: "hola" })).toBe("idle");
    expect(activityFor(result("1", null, true))).toBe("blocked");
    expect(activityFor({ kind: "hook", name: "x", phase: "started" })).toBeUndefined();
  });
});

describe("buildRunAgents", () => {
  it("shows the profile steps not run yet as waiting agents", () => {
    const run = makeRun({ steps: [step("classify", "succeeded", { model: "haiku" }), step("enrich", "running", { model: "haiku" })] });
    const agents = buildRunAgents(run, plannedSteps(run, config), {}, NOW);
    expect(agents.map((agent) => [agent.kind, agent.step, agent.activity])).toEqual([
      ["step", "classify", "done"],
      ["step", "enrich", "thinking"],
      ["planned", "plan", "waiting"],
      ["planned", "implement", "waiting"],
      ["planned", "qaCode", "waiting"],
    ]);
    expect(agents[2]).toMatchObject({ id: "planned-plan", model: "sonnet" });
    expect(agents[2]!.stepRunId).toBeUndefined();
    expect(agents[4]!.builtin).toBe(true);
  });

  it("derives the running step's activity from its last event", () => {
    const run = makeRun({ steps: [step("implement", "running")] });
    const events = { "sr-implement": [ev(1, { kind: "thinking", text: "" }), ev(2, use("e1", "Edit", { file_path: "C:/repo/src/app.ts" }))] };
    const [agent] = buildRunAgents(run, [], events, NOW);
    expect(agent).toMatchObject({ activity: "typing", currentTool: "Edit", bubble: "Edit app.ts" });
  });

  it("a subagent appears next to its step while it works and ends with its tool result", () => {
    const run = makeRun({ steps: [step("implement", "running")] });
    const working = [
      ev(1, use("agent1", "Agent", { description: "Buscar estilos", subagent_type: "Explore", prompt: "…" })),
      ev(2, use("g1", "Grep", { pattern: "badge" }, "agent1")),
    ];
    let [agent] = buildRunAgents(run, [], { "sr-implement": working }, NOW);
    expect(agent!.activity).toBe("delegating");
    expect(agent!.bubble).toBe("1 subagente trabajando");
    expect(agent!.children).toHaveLength(1);
    expect(agent!.children[0]).toMatchObject({
      id: "agent1",
      kind: "subagent",
      label: "Buscar estilos",
      activity: "reading",
      bubble: "Grep badge",
      stepRunId: "sr-implement",
      startedAt: at(1),
    });
    expect(countWorking([agent!])).toBe(2);

    const finished = [...working, ev(3, result("g1", "agent1")), ev(4, result("agent1")), ev(5, use("e1", "Edit", { file_path: "a.ts" }))];
    [agent] = buildRunAgents(run, [], { "sr-implement": finished }, NOW);
    expect(agent!.activity).toBe("typing");
    expect(agent!.children[0]).toMatchObject({ activity: "done", finishedAt: at(4) });
    expect(countWorking([agent!])).toBe(1);
  });

  it("a subagent whose tool result is an error failed; open ones end with their step", () => {
    const events = { "sr-implement": [ev(1, use("a1", "Task", { subagent_type: "general-purpose" })), ev(2, result("a1", null, true)), ev(3, use("a2", "Agent", {}))] };
    const running = buildRunAgents(makeRun({ steps: [step("implement", "running")] }), [], events, NOW)[0]!;
    expect(running.children.map((child) => [child.label, child.activity])).toEqual([
      ["general-purpose", "failed"],
      ["Subagente", "thinking"],
    ]);
    const done = buildRunAgents(makeRun({ steps: [step("implement", "succeeded", { finishedAt: at(9) })] }), [], events, NOW)[0]!;
    expect(done.children.map((child) => child.activity)).toEqual(["failed", "done"]);
  });

  it("a tool error blocks the agent only briefly", () => {
    const run = makeRun({ steps: [step("implement", "running")] });
    const events = { "sr-implement": [ev(1, use("b1", "Bash", { command: "npm test" })), ev(2, result("b1", null, true))] };
    expect(buildRunAgents(run, [], events, Date.parse(at(3)))[0]!.activity).toBe("blocked");
    expect(buildRunAgents(run, [], events, NOW)[0]!.activity).toBe("thinking");
  });

  it("a paused run blocks the step waiting for approval", () => {
    const run = makeRun({
      status: "paused",
      pendingStep: { step: "plan", prompt: "…" },
      steps: [step("classify", "succeeded"), step("enrich", "succeeded")],
    });
    const agents = buildRunAgents(run, plannedSteps(run, config), {}, NOW);
    expect(agents.find((agent) => agent.step === "plan")).toMatchObject({ kind: "planned", activity: "blocked", bubble: "esperando aprobación" });
    expect(agents.filter((agent) => agent.activity === "blocked")).toHaveLength(1);
    // Waiting for the user is not working.
    expect(countWorking(agents)).toBe(0);
  });

  it("a run waiting for quota blocks the next agent", () => {
    const run = makeRun({ status: "waiting-rate-limit", steps: [step("classify", "succeeded")] });
    const agents = buildRunAgents(run, plannedSteps(run, config), {}, NOW);
    expect(agents[1]).toMatchObject({ step: "enrich", activity: "blocked", bubble: "esperando cuota" });
  });

  it("builtin steps are robots without model or cost; finished runs have no waiting agents", () => {
    const run = makeRun({
      status: "failed",
      steps: [step("implement", "succeeded"), step("qaCode", "failed", { kind: "builtin", error: "npm run lint falló", costUsd: 0 })],
    });
    const agents = buildRunAgents(run, plannedSteps(run, config), {}, NOW);
    expect(agents.map((agent) => agent.step)).toEqual(["implement", "qaCode"]);
    expect(agents[1]).toMatchObject({ kind: "builtin", model: undefined, activity: "failed", bubble: "npm run lint falló" });
  });

  it("labels retries and loops with the attempt", () => {
    const run = makeRun({ steps: [step("implement", "succeeded"), step("implement", "running", { id: "sr-implement-2", attempt: 2, seq: 2 })] });
    expect(buildRunAgents(run, [], {}, NOW).map((agent) => agent.label)).toEqual(["Implementar", "Implementar #2"]);
  });
});
