import { describe, expect, it } from "vitest";
import type { AgentActivity, AgentNode } from "../../core/agents";
import { lookFor, modelFamily, teamColors, TEAM_COLORS } from "./looks";
import { officeMembers, planOffice, type OfficeTeam, type Plan } from "./office-plan";
import { cellAt, findPath, OfficeSim } from "./office-sim";

function node(runId: string, step: string, activity: AgentActivity, extra: Partial<AgentNode> = {}): AgentNode {
  return { id: `${runId}-${step}-${extra.id ?? "1"}`, runId, kind: "step", step, stepRunId: `${runId}-${step}`, label: step, model: "sonnet", activity, children: [], ...extra };
}

function team(id: string, live: boolean, agents: AgentNode[]): OfficeTeam {
  return { id, title: `Flujo ${id}`, color: "#e5534b", live, agents };
}

/** Seeded random so the simulation is reproducible. */
function rng(seed = 42): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

function reachable(plan: Plan, cell: number): boolean {
  return findPath(plan, plan.door, cell) !== null;
}

const busy = team("r1", true, [
  node("r1", "enrich", "done"),
  node("r1", "plan", "done"),
  node("r1", "implement", "typing", {
    children: [{ ...node("r1", "sub", "reading"), id: "toolu_1", kind: "subagent" }],
  }),
  node("r1", "codeReview", "waiting", { kind: "planned", stepRunId: undefined }),
]);
const finished = team("r2", false, [node("r2", "plan", "done"), node("r2", "implement", "failed")]);

describe("officeMembers", () => {
  it("keeps the last attempt of each step and adds the subagents", () => {
    const retried = team("r3", true, [node("r3", "implement", "failed", { id: "a" }), node("r3", "implement", "typing", { id: "b" })]);
    const members = officeMembers([busy, retried]);
    expect(members.map((member) => member.key)).toEqual([
      "r1:enrich",
      "r1:plan",
      "r1:implement",
      "r1:sub:toolu_1",
      "r1:codeReview",
      "r3:implement",
    ]);
    expect(members.at(-1)!.node.activity).toBe("typing");
    expect(members[3]).toMatchObject({ sub: true, parentKey: "r1:implement" });
  });
});

describe("looks", () => {
  it("dresses by model and keeps the look of a step stable", () => {
    const opus = lookFor({ seed: "r1:plan", model: "opus", step: "plan", robot: false, subagent: false, team: "#fff" });
    expect(opus.top).toBe("suit");
    expect(lookFor({ seed: "r1:plan", model: "haiku", step: "plan", robot: false, subagent: false, team: "#fff" }).top).toBe("tee");
    expect(lookFor({ seed: "r1:implement", model: "opus", step: "implement", robot: false, subagent: false, team: "#fff" }).accessory).toBe("headphones");
    expect(lookFor({ seed: "r1:plan", model: "opus", step: "plan", robot: false, subagent: false, team: "#fff" })).toEqual(opus);
  });

  it("recognises the models of Codex and Copilot too", () => {
    expect(modelFamily("gpt-5-codex")).toBe("gpt");
    expect(modelFamily("o3")).toBe("gpt");
    expect(modelFamily("gemini-2.5-pro")).toBe("gemini");
    // Claude through Copilot dresses like Claude.
    expect(modelFamily("claude-sonnet-4.5")).toBe("sonnet");
    expect(lookFor({ seed: "r1:implement", model: "gpt-5-codex", step: "implement", robot: false, subagent: false, team: "#fff" }).top).toBe("shirt");
    expect(lookFor({ seed: "r1:plan", model: "gemini-2.5-pro", step: "plan", robot: false, subagent: false, team: "#fff" }).top).toBe("hoodie");
  });

  it("gives up to eight flows different colours", () => {
    const ids = Array.from({ length: TEAM_COLORS.length }, (_, index) => `run-${index}`);
    expect(new Set(teamColors(ids).values()).size).toBe(TEAM_COLORS.length);
  });
});

describe("planOffice", () => {
  for (const width of [130, 250, 380, 560]) {
    it(`fits ${width}px with a desk for every step of a live flow and everything reachable`, () => {
      const teams = [busy, finished];
      const members = officeMembers(teams);
      const plan = planOffice(teams, members, width);
      expect(plan.width).toBeLessThanOrEqual(Math.max(width, 14 * 8));
      expect(plan.wide).toBe(width >= 256);
      const desks = plan.seats.filter((seat) => seat.kind === "desk");
      expect(desks.map((seat) => seat.owner).sort()).toEqual(["r1:codeReview", "r1:enrich", "r1:implement", "r1:plan"]);
      expect(plan.seats.filter((seat) => seat.kind === "hot" && seat.teamId === "r1")).toHaveLength(2);
      expect(plan.pods.map((pod) => pod.teamId)).toEqual(["r1"]);
      expect(plan.walk[plan.door]).toBe(1);
      for (const seat of plan.seats) {
        expect(reachable(plan, seat.cell), `seat ${seat.id}`).toBe(true);
      }
      for (const poi of plan.pois) {
        expect(reachable(plan, poi.cell), `poi ${poi.id}`).toBe(true);
      }
      expect(plan.rooms.map((room) => room.key)).toEqual(expect.arrayContaining(["work", "lounge", "kitchen", "games"]));
      // One table, or two in the extra-wide games room under the lounge and the kitchen.
      expect(plan.pois.filter((poi) => poi.kind === "pingpong")).toHaveLength(width >= 400 ? 4 : 2);
    });
  }

  it("keeps the same signature while nothing structural changes", () => {
    const members = officeMembers([busy]);
    const a = planOffice([busy], members, 380);
    const moved = team("r1", true, busy.agents.map((agent) => ({ ...agent, activity: agent.activity === "typing" ? "reading" : agent.activity })));
    const b = planOffice([moved], officeMembers([moved]), 380);
    expect(b.signature).toBe(a.signature);
    expect(planOffice([busy, team("r9", true, [node("r9", "plan", "thinking")])], members, 380).signature).not.toBe(a.signature);
  });

  it("grows the office with the flows and gives the extra height to the games room", () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      team(`m${index}`, true, ["enrich", "plan", "implement", "codeReview", "qaCode", "release"].map((step) => node(`m${index}`, step, "thinking"))),
    );
    const plan = planOffice(many, officeMembers(many), 380);
    expect(plan.pods).toHaveLength(6);
    expect(plan.rooms.find((room) => room.key === "games")!.h).toBeGreaterThan(8);
    expect(plan.items.some((item) => item.kind === "meetingTable")).toBe(true);
    for (const target of [...plan.seats, ...plan.pois]) {
      expect(reachable(plan, target.cell), target.id).toBe(true);
    }
  });
});

describe("OfficeSim", () => {
  function run(sim: OfficeSim, from: number, ms: number): number {
    let now = from;
    for (; now < from + ms; now += 50) {
      sim.update(now, 50);
    }
    return now;
  }

  it("sits working agents at their desk and sends everyone else to relax", () => {
    const teams = [busy, finished];
    const members = officeMembers(teams);
    const plan = planOffice(teams, members, 380);
    const sim = new OfficeSim(rng());
    sim.setScene(plan, members, 0);
    const implement = sim.actor("r1:implement")!;
    const desk = plan.seats.find((seat) => seat.owner === "r1:implement")!;
    expect([implement.x, implement.y, implement.pose]).toEqual([desk.x, desk.y, "work"]);
    const sub = sim.actor("r1:sub:toolu_1")!;
    expect(sub.seat?.kind).toBe("hot");

    const now = run(sim, 0, 60_000);
    expect(sim.actor("r1:implement")!.pose).toBe("work");
    for (const actor of sim.actors) {
      const onSeat = plan.seats.some((seat) => seat.x === actor.x && seat.y === actor.y);
      const cell = cellAt(plan, actor.x, actor.y);
      const seatCell = plan.seats.some((seat) => seat.cell === cell);
      expect(onSeat || plan.walk[cell] === 1 || seatCell, `${actor.key} at ${actor.x},${actor.y}`).toBe(true);
    }
    expect(now).toBeGreaterThan(0);
  });

  it("walks an agent to its desk when its step starts and lets a finished subagent leave", () => {
    const members = officeMembers([busy]);
    const plan = planOffice([busy], members, 380);
    const sim = new OfficeSim(rng(7));
    sim.setScene(plan, members, 0);
    let now = run(sim, 0, 5000);

    const started = team("r1", true, [
      ...busy.agents.slice(0, 2),
      { ...busy.agents[2]!, activity: "thinking", children: [{ ...busy.agents[2]!.children[0]!, activity: "done" }] },
      { ...busy.agents[3]!, kind: "step", activity: "thinking", stepRunId: "r1-codeReview" },
    ]);
    const next = officeMembers([started]);
    sim.setScene(planOffice([started], next, 380), next, now);
    now = run(sim, now, 90_000);
    const review = sim.actor("r1:codeReview")!;
    const desk = plan.seats.find((seat) => seat.owner === "r1:codeReview")!;
    expect([review.x, review.y, review.pose]).toEqual([desk.x, desk.y, "work"]);
    expect(sim.actor("r1:sub:toolu_1")).toBeUndefined();

    // It does not come back while its step is still listed.
    sim.setScene(planOffice([started], next, 380), next, now);
    expect(sim.actor("r1:sub:toolu_1")).toBeUndefined();
  });

  it("keeps people chatting side by side and nobody else standing on top of them", () => {
    const idle = Array.from({ length: 3 }, (_, index) =>
      team(`d${index}`, false, ["enrich", "plan", "implement", "codeReview"].map((step) => node(`d${index}`, step, "done"))),
    );
    const members = officeMembers(idle);
    const plan = planOffice(idle, members, 380);
    let chats = 0;
    for (const seed of [11, 12, 13, 14, 15]) {
      const sim = new OfficeSim(rng(seed));
      sim.setScene(plan, members, 0);
      for (let now = 0; now < 120_000; now += 50) {
        sim.update(now, 50);
        for (const actor of sim.actors) {
          const step = actor.queue[0];
          if (actor.pose !== "talk" || step?.t !== "chat") {
            continue;
          }
          const { a, b } = step.chat;
          chats++;
          expect(Math.abs(a.x - b.x), `${a.key} and ${b.key}`).toBeGreaterThanOrEqual(16);
          expect(a.y).toBe(b.y);
          // Passers-by may cross, but nobody stops next to them.
          for (const other of sim.actors) {
            if (other === a || other === b || other.seat || other.pose === "walk") {
              continue;
            }
            const overlaps = Math.abs(other.x - actor.x) < 14 && Math.abs(other.y - actor.y) < 6;
            expect(overlaps, `${other.key} on top of ${actor.key} (seed ${seed})`).toBe(false);
          }
        }
      }
    }
    expect(chats).toBeGreaterThan(0);
  });

  it("places everyone still when motion is reduced", () => {
    const teams = [busy, finished];
    const members = officeMembers(teams);
    const plan = planOffice(teams, members, 380);
    const sim = new OfficeSim(rng(3));
    sim.setAnimated(false, 0);
    sim.setScene(plan, members, 0);
    const before = sim.actors.map((actor) => [actor.key, actor.x, actor.y]);
    run(sim, 0, 10_000);
    expect(sim.actors.map((actor) => [actor.key, actor.x, actor.y])).toEqual(before);
  });
});
