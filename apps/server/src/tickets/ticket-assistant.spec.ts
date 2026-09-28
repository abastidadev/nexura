import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig, TicketDraft, TicketItem, TicketOptions } from "@nexura/shared";

// Env must be set before the modules read their paths.
const root = mkdtempSync(join(tmpdir(), "nexura-tickets-"));
const repoPath = join(root, "sandbox");
const stateDir = join(root, "state");
process.env.NEXURA_DATA_DIR = join(root, "data");
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures");
process.env.NEXURA_CLAUDE_BIN = join(FIXTURES, "fake-claude.mjs");
process.env.NEXURA_CODEX_BIN = join(FIXTURES, "fake-codex.mjs");
process.env.NEXURA_COPILOT_BIN = join(FIXTURES, "fake-copilot.mjs");
process.env.FAKE_STATE_DIR = stateDir;
process.env.NEXURA_TRUST_WORKTREES = "0";
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");

const { TicketAssistant, TicketDraftError } = await import("./ticket-assistant.ts");
const { TicketDraftStore } = await import("./ticket-draft-store.ts");
type Assistant = InstanceType<typeof TicketAssistant>;

const repos: RepoConfig[] = [{ name: "sandbox", path: repoPath, baseBranch: "main", checks: [] }];

const OPTIONS: TicketOptions = {
  source: "github",
  target: "nexura-fake/sandbox",
  types: { story: "", bug: "" },
  teams: [],
  iterations: [
    { value: "1", name: "Sprint 12", current: true },
    { value: "2", name: "Sprint 13", current: false },
  ],
  people: [{ value: "ana", name: "ana" }],
  me: "ana",
  labels: ["bug", "Frontend", "Backend"],
};

/** What the fake forge created, per call. */
const created: TicketItem[][] = [];

function assistant(store = new TicketDraftStore(":memory:")): Assistant {
  return new TicketAssistant(store, {
    repos: () => repos,
    settings: () => ({ memoryEnabled: false }),
    timeoutMs: 20_000,
    forge: {
      sourceOf: async () => "github",
      target: async () => ({ source: "github", owner: "nexura-fake", repo: "sandbox" }),
      options: async () => OPTIONS,
      similar: async () => [
        { id: 7, title: "Orders / History – Totals column shows 0", type: "Issue", state: "closed", tags: ["bug", "Frontend"], reproSteps: "**Error description:**\n\nSAMPLE-REPRO" },
      ],
      create: async (items, _targetOf, saved) => {
        const result = items.map((item, index) => ({ ...item, created: item.created ?? { id: 300 + index, url: `https://github.com/x/y/issues/${300 + index}` } }));
        saved(result);
        created.push(result);
        return result;
      },
    },
  });
}

/** Resolves when the draft stops thinking. */
function settled(tickets: Assistant, id: string): Promise<TicketDraft> {
  return new Promise((resolve) => {
    const check = (message: { type: string; draft?: TicketDraft }): void => {
      if (message.type === "ticketDraft" && message.draft?.id === id && message.draft.status !== "thinking") {
        tickets.off("message", check);
        resolve(message.draft);
      }
    };
    tickets.on("message", check);
  });
}

async function started(tickets: Assistant, agent?: "codex"): Promise<TicketDraft> {
  const draft = await tickets.start({ repo: "sandbox", kind: "bug", idea: "En el historial de pedidos no sale el estado", ...(agent ? { agent: { agent, model: "gpt-5.5", effort: "medium" } } : {}) });
  return settled(tickets, draft.id);
}

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  created.length = 0;
});

// A git checkout: the prompt gets the repo map from `git ls-files`.
mkdirSync(repoPath, { recursive: true });
writeFileSync(join(repoPath, "CLAUDE.md"), "# Sandbox\n");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
execFileSync("git", ["add", "."], { cwd: repoPath });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoPath });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("TicketAssistant (fake agents, fake forge)", () => {
  it("first turn: asks with suggested answers and applies the board defaults", async () => {
    const tickets = assistant();
    const draft = await started(tickets);

    expect(draft.status).toBe("idle");
    expect(draft.source).toBe("github");
    expect(draft.sessionId).toBeTruthy();
    expect(draft.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(draft.messages[1]!.questions?.[0]).toEqual({ text: "¿Con qué usuario lo has visto?", options: ["demo", "admin", "Con todos"] });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ side: "frontend", kind: "bug", description: "", repo: "sandbox", iteration: "1", assignee: "" });
    expect(draft.missing).toEqual(["La cuenta con la que se reproduce"]);
    expect(draft.ready).toBe(false);
    expect(tickets.get(draft.id).status).toBe("idle");
  });

  it("an answer resumes the same session and keeps where the person put the item", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    tickets.update(draft.id, { items: [{ ...draft.items[0]!, assignee: "ana", iteration: "2" }] });

    tickets.reply(draft.id, "Con el usuario demo, en todos los pedidos");
    const answered = await settled(tickets, draft.id);

    expect(answered.sessionId).toBe(draft.sessionId);
    expect(answered.ready).toBe(true);
    expect(answered.suggestSplit).toBe(true);
    expect(answered.items[0]).toMatchObject({ key: draft.items[0]!.key, assignee: "ana", iteration: "2" });
    expect(answered.items[0]!.reproSteps).toContain("**Steps to reproduce the error:**");
    expect(answered.messages.at(-2)).toMatchObject({ role: "user", text: "Con el usuario demo, en todos los pedidos" });
  });

  it("refuses a new turn or an edit while it thinks", async () => {
    const tickets = assistant();
    const draft = await tickets.start({ repo: "sandbox", kind: "bug", idea: "No sale el estado" });
    expect(() => tickets.reply(draft.id, "hola")).toThrow(TicketDraftError);
    expect(() => tickets.update(draft.id, { items: draft.items })).toThrow("Espera a que el asistente termine");
    await settled(tickets, draft.id);
  });

  it("splits into linked frontend and backend items; the new one goes where the first goes", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    // Edits not saved yet travel with the action.
    tickets.split(draft.id, { items: [{ ...draft.items[0]!, assignee: "ana" }] });
    const split = await settled(tickets, draft.id);

    expect(split.items.map((item) => item.side)).toEqual(["frontend", "backend"]);
    expect(split.items[0]!.key).toBe(draft.items[0]!.key);
    expect(split.items[1]).toMatchObject({ repo: "sandbox", iteration: "1", assignee: "ana", tags: ["Backend"] });
    expect(split.suggestSplit).toBe(false);
    expect(() => tickets.split(draft.id)).toThrow("ya está dividido");
  });

  it("creates on the board only when asked, and then the draft is closed", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    tickets.reply(draft.id, "demo");
    await settled(tickets, draft.id);

    const done = await tickets.create(draft.id);

    expect(created).toHaveLength(1);
    expect(done.status).toBe("created");
    expect(done.items[0]!.created).toEqual({ id: 300, url: "https://github.com/x/y/issues/300" });
    expect(() => tickets.reply(draft.id, "otra cosa")).toThrow("ya está creado");
  });

  it("does not create an item without its required text", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    tickets.update(draft.id, { items: [{ ...draft.items[0]!, reproSteps: " " }] });
    await expect(tickets.create(draft.id)).rejects.toThrow("Faltan los pasos para reproducir el bug");
    expect(created).toHaveLength(0);
  });

  it("never creates what looks like a credential", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    const leaked = { ...draft.items[0]!, reproSteps: "1. Log in\n\nExpected: ok\n\npassword=hunter2hunter2" };
    await expect(tickets.create(draft.id, { items: [leaked] })).rejects.toThrow("contraseña o clave");
    expect(created).toHaveLength(0);
    // The edit is kept, so the person can fix it.
    expect(tickets.get(draft.id).items[0]!.reproSteps).toContain("hunter2");
  });

  it("an edit cannot add items, repeat them or move one already created", async () => {
    const tickets = assistant();
    const draft = await started(tickets);
    const item = draft.items[0]!;
    tickets.update(draft.id, { items: [item, item, item, { ...item, key: "forged" }] });
    expect(tickets.get(draft.id).items).toHaveLength(1);

    tickets.split(draft.id);
    const split = await settled(tickets, draft.id);
    const [front, back] = split.items;
    // Pretend the first one was created and the second failed.
    const store = (tickets as unknown as { store: InstanceType<typeof TicketDraftStore> }).store;
    store.save({ ...split, status: "error", items: [{ ...front!, created: { id: 1, url: "u" } }, back!] });
    tickets.update(draft.id, { items: [{ ...front!, repo: "other", title: "changed" }] });
    const after = tickets.get(draft.id).items;
    expect(after.map((entry) => entry.key)).toEqual([front!.key]);
    expect(after[0]).toMatchObject({ repo: "sandbox", created: { id: 1 } });
  });

  it("rejects a model or effort that is not valid for the agent", async () => {
    const tickets = assistant();
    await expect(tickets.start({ repo: "sandbox", kind: "bug", idea: "x", agent: { agent: "claude", model: "--dangerously", effort: "medium" } })).rejects.toThrow("no válido");
    await expect(tickets.start({ repo: "sandbox", kind: "bug", idea: "x", agent: { agent: "claude", model: "sonnet", effort: "max" as "high" } })).rejects.toThrow("no válido");
  });

  it("stops a turn and keeps the draft usable", async () => {
    process.env.FAKE_DELAY_MS = "5000";
    try {
      const tickets = assistant();
      const draft = await tickets.start({ repo: "sandbox", kind: "story", idea: "Quiero exportar pedidos" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      tickets.cancel(draft.id);
      const stopped = await settled(tickets, draft.id);
      expect(stopped.status).toBe("idle");
      expect(stopped.messages.at(-1)?.text).toContain("Parado");
    } finally {
      delete process.env.FAKE_DELAY_MS;
    }
  }, 20_000);

  it("a turn cut by a restart ends as an error, not thinking forever", () => {
    const store = new TicketDraftStore(":memory:");
    const now = new Date().toISOString();
    store.save({
      id: "d1", repo: "sandbox", source: "github", kind: "bug", idea: "x", agent: { agent: "claude", model: "sonnet", effort: "medium" },
      messages: [], items: [], suggestSplit: false, missing: [], ready: false, status: "thinking", createdAt: now, updatedAt: now,
    });
    const tickets = assistant(store);
    expect(tickets.get("d1")).toMatchObject({ status: "error", error: expect.stringContaining("reiniciar") });
  });

  it("the first prompt has the rules, the board, the team's tickets and the templates (codex, read-only)", async () => {
    const tickets = assistant();
    const draft = await started(tickets, "codex");
    expect(draft.status).toBe("idle");
    const call = JSON.parse(readFileSync(join(stateDir, "codex-ticketDraft-1.json"), "utf8")) as { args: string[]; prompt: string };
    expect(call.prompt).toContain("Eres el paso **ticketDraft**");
    expect(call.prompt).toContain("En el historial de pedidos no sale el estado");
    expect(call.prompt).toContain("Sprint en curso: Sprint 12");
    expect(call.prompt).toContain("SAMPLE-REPRO");
    expect(call.prompt).toContain("# Work item templates");
    expect(call.args.join(" ")).toContain("read-only");
  });
});
