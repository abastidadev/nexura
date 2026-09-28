import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRun } from "@nexura/shared";
import {
  automaticMcpNames,
  cacheContinuity,
  contextTooLarge,
  continuesMainSession,
  correctionSession,
  fingerprint,
  mainSessionEnvelope,
  MAX_CONTEXT_TOKENS,
  observeContext,
  phaseOutput,
  sessionSchema,
  resolveStepMcp,
} from "./context-policy.ts";

const step = (overrides: Partial<StepRun> = {}): StepRun => ({
  id: "previous", runId: "run", step: "implement", attempt: 1, seq: 0, status: "succeeded", kind: "claude", agent: "claude",
  model: "sonnet", effort: "medium", sessionId: "session", costUsd: 0, numTurns: 12, ...overrides,
});
const metrics = (): NonNullable<StepRun["contextMetrics"]> => ({
  promptChars: 10, memoryChars: 0, ledgerChars: 0, mcpServers: [], resumeDepth: 0, sessionTurnsBefore: 0,
  sessionDecision: "new", toolCalls: 0, readCalls: 0, repeatedReadCalls: 0, toolResultChars: 0,
});

describe("correction session policy", () => {
  it("reuses a completed compatible session", () => {
    const previous = step();
    expect(correctionSession(previous, step({ id: "next" })).previous).toBe(previous);
  });

  it.each([
    { agent: "codex" }, { model: "opus" }, { effort: "high" }, { status: "failed" }, { sessionId: undefined },
  ] satisfies Partial<StepRun>[])("starts fresh when continuity is unsuitable: %j", (override) => {
    expect(correctionSession(step(override), step()).previous).toBeUndefined();
  });

  it("keeps the session beyond 80 turns and several corrections", () => {
    const previous = step({ numTurns: 97, contextMetrics: { ...metrics(), correctionTurnsBefore: 145, correctionDepth: 3 } });
    expect(correctionSession(previous, step({ id: "next" })).previous).toBe(previous);
  });

  it("starts fresh once the conversation is past the context limit, measured in real tokens", () => {
    const small = step({ contextMetrics: { ...metrics(), contextTokens: MAX_CONTEXT_TOKENS - 1 } });
    const large = step({ contextMetrics: { ...metrics(), contextTokens: MAX_CONTEXT_TOKENS } });
    expect(contextTooLarge(small)).toBeUndefined();
    expect(contextTooLarge(large)).toBe(`contexto de ${MAX_CONTEXT_TOKENS} tokens: sesión nueva`);
    expect(correctionSession(large, step({ id: "next" }))).toEqual({ reason: `contexto de ${MAX_CONTEXT_TOKENS} tokens: sesión nueva` });
    // Without a measurement (an old run, another agent) nothing is assumed.
    expect(contextTooLarge(step())).toBeUndefined();
  });
});

describe("main session", () => {
  it("is carried on by the work phases; judging and summarising start fresh", () => {
    expect(["enrich", "plan", "implement", "addressReview", "docs"].every(continuesMainSession)).toBe(true);
    expect(["classify", "codeReview", "prReview", "qaNotes"].some(continuesMainSession)).toBe(false);
  });

  it("shares the union of the phases' tools, servers and memory, in a stable order", () => {
    const plan = { tools: ["Read", "Glob", "Grep", "Skill"], disallowedTools: [], mcpServers: ["@auto"], memory: "read" as const };
    const implement = { tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill"], disallowedTools: ["Agent", "Bash(git commit*)"], mcpServers: ["@auto", "github"], memory: "readwrite" as const };
    const envelope = mainSessionEnvelope([plan, implement]);
    expect(envelope).toEqual({
      tools: ["Read", "Glob", "Grep", "Skill", "Edit", "Write", "Bash"],
      disallowedTools: ["Agent", "Bash(git commit*)"],
      mcpServers: ["@auto", "github"],
      memory: "readwrite",
    });
    expect(mainSessionEnvelope([implement, plan]).memory).toBe("readwrite");
    expect(mainSessionEnvelope([{ ...plan, memory: "off" }]).memory).toBe("off");
  });

  it("gives every phase the same output schema and reads each phase's answer from its key", () => {
    const plan = { type: "object", properties: { approach: { type: "string" } } };
    const schema = sessionSchema([{ name: "plan", schema: plan }, { name: "docs" }]) as { properties: Record<string, unknown> };
    expect(schema.properties).toEqual({ plan, docs: expect.objectContaining({ type: "string" }) });
    expect(JSON.stringify(sessionSchema([{ name: "plan", schema: plan }, { name: "docs" }]))).toBe(JSON.stringify(schema));
    expect(phaseOutput({ plan: { approach: "x" } }, "plan")).toEqual({ approach: "x" });
    expect(phaseOutput({ plan: { approach: "x" } }, "implement")).toBeUndefined();
    expect(phaseOutput(undefined, "plan")).toBeUndefined();
  });

  it("resolves @auto once for all the phases, so none of them adds a server later", () => {
    const root = mkdtempSync(join(tmpdir(), "nexura-envelope-mcp-"));
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, "home");
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "repo"));
    try {
      writeFileSync(join(root, "home", ".claude.json"), JSON.stringify({ mcpServers: { context7: { command: "docs" }, playwright: { command: "browser" } } }));
      const alone = Object.keys(resolveStepMcp(join(root, "repo"), ["@auto"], "plan", "pantalla UI", []).servers);
      const shared = Object.keys(resolveStepMcp(join(root, "repo"), ["@auto"], ["plan", "implement"], "pantalla UI", []).servers);
      expect(alone).toEqual(["context7"]);
      expect(shared.sort()).toEqual(["context7", "playwright"]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells whether a continuation reused the cache and what changed when it did not", () => {
    const shared = { toolsFingerprint: fingerprint(["Read", "Edit"]), schemaFingerprint: fingerprint({ a: 1 }), systemFingerprint: fingerprint("mem") };
    const plan = step({ step: "plan", contextMetrics: { ...metrics(), ...shared, contextTokens: 100_000 } });
    const reused = step({ contextMetrics: { ...metrics(), ...shared, firstCallCacheRead: 99_000 } });
    expect(cacheContinuity(plan, reused)).toEqual({ reused: true, changed: [] });

    const lost = step({ model: "opus", contextMetrics: { ...metrics(), ...shared, schemaFingerprint: fingerprint({ b: 2 }), firstCallCacheRead: 0 } });
    expect(cacheContinuity(plan, lost)).toEqual({ reused: false, changed: ["modelo", "schema de salida"] });
    // Nothing measured, nothing judged.
    expect(cacheContinuity(step(), reused)).toBeUndefined();
  });
});

describe("automatic MCP selection", () => {
  const available = ["context7", "angular-cli", "playwright", "github", "billing"];
  it("loads documentation selectively and browser tools only for an applicable writer", () => {
    expect(automaticMcpNames(available, "implement", "Arreglar pantalla Angular")).toEqual(["context7", "angular-cli", "playwright"]);
    expect(automaticMcpNames(available, "codeReview", "Arreglar pantalla Angular")).toEqual(["context7", "angular-cli"]);
    expect(automaticMcpNames(available, "enrich", "Cambiar endpoint Go")).toEqual(["context7"]);
    expect(automaticMcpNames(available, "classify", "Angular")).toEqual([]);
    expect(automaticMcpNames(["github"], "implement", "Angular")).toEqual([]);
  });

  it("keeps the enabled user spec when a disabled project server has the same name", () => {
    const root = mkdtempSync(join(tmpdir(), "nexura-auto-mcp-"));
    const previousHome = process.env.CLAUDE_CONFIG_DIR;
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { playwright: { command: "enabled-user-browser" } } }));
      writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "disabled-project-browser" } } }));
      expect(resolveStepMcp(repo, ["@auto"], "implement", "pantalla UI", []).servers.playwright).toEqual({ command: "enabled-user-browser" });
      // Explicit configuration keeps its existing precedence and permission semantics.
      expect(resolveStepMcp(repo, ["@auto", "playwright"], "implement", "pantalla UI", []).servers.playwright).toEqual({ command: "disabled-project-browser" });
    } finally {
      if (previousHome === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("counts explicit repeated reads by file and range, without treating another range as repeated", () => {
  const observation = metrics();
  const reads = new Set<string>();
  for (const offset of [0, 0, 100]) {
    observeContext(observation, reads, { kind: "toolUse", id: String(offset), name: "Read", input: { file_path: "src/app.ts", offset }, parentToolUseId: null });
  }
  observeContext(observation, reads, { kind: "toolResult", toolUseId: "0", content: "hello", isError: false, parentToolUseId: null });
  expect(observation).toMatchObject({ toolCalls: 3, readCalls: 3, repeatedReadCalls: 1, toolResultChars: 5 });
});
