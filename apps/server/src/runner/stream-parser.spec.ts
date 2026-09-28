import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NexuraEvent } from "@nexura/shared";
import { LineSplitter, normalize, parseLine, StreamUsage, usageBeyond } from "./stream-parser.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { claudeAdapter } from "./claude-adapter.ts";
import { claudeEnv } from "./claude-process.ts";
import { memoryProtocol, memoryRunOptions } from "../memory/memory.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "stream");
const REAL_CONFIG = join(import.meta.dirname, "..", "..", "..", "..", "config");

function load(name: string): NexuraEvent[] {
  const text = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");
  const splitter = new LineSplitter();
  return [...splitter.push(text), ...splitter.flush()].flatMap((line) => normalize(parseLine(line)!));
}

function resultOf(events: NexuraEvent[]): Extract<NexuraEvent, { kind: "result" }> {
  const result = events.find((event) => event.kind === "result");
  if (result?.kind !== "result") {
    throw new Error("no result event");
  }
  return result;
}

describe("LineSplitter", () => {
  it("joins lines split across chunks", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.flush()).toEqual(['{"c"']);
  });
});

describe("normalize (real fixtures)", () => {
  it("parses a plain answer with init, rate limit and result", () => {
    const events = load("01-plain");
    const init = events.find((event) => event.kind === "init");
    expect(init?.kind === "init" && init.model).toContain("haiku");
    expect(events.some((event) => event.kind === "rateLimit")).toBe(true);
    const result = resultOf(events);
    expect(result.success).toBe(true);
    expect(result.text).toBe("NEXURA_OK");
    expect(result.costUsd).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "unknown")).toBe(false);
  });

  it("exposes the structured output forced by --json-schema", () => {
    const result = resultOf(load("02-json-schema"));
    expect(result.structuredOutput).toMatchObject({ profile: "minimal" });
  });

  it("pairs tool_use with its tool_result", () => {
    const events = load("03-tool-use");
    const use = events.find((event) => event.kind === "toolUse");
    const res = events.find((event) => event.kind === "toolResult");
    expect(use?.kind === "toolUse" && use.name).toBe("Read");
    expect(res?.kind === "toolResult" && use?.kind === "toolUse" && res.toolUseId === use.id).toBe(true);
  });

  it("tags the subagent's events with the id of its Agent tool use (hand-built fixture)", () => {
    const events = load("07-subagent");
    const agent = events.find((event) => event.kind === "toolUse" && event.name === "Agent");
    if (agent?.kind !== "toolUse") {
      throw new Error("no Agent tool use");
    }
    expect(agent.parentToolUseId).toBeNull();
    expect(agent.input).toMatchObject({ description: "Buscar estilos del badge", subagent_type: "Explore" });
    const inner = events.filter((event) => (event.kind === "toolUse" || event.kind === "toolResult") && event.parentToolUseId === agent.id);
    expect(inner.map((event) => (event.kind === "toolUse" ? event.name : "result"))).toEqual(["Grep", "result", "Read", "result"]);
    const end = events.find((event) => event.kind === "toolResult" && event.toolUseId === agent.id);
    expect(end?.kind === "toolResult" && end.parentToolUseId).toBeNull();
    expect(end?.kind === "toolResult" && end.content).toContain("badge.css:1");
    const edit = events.find((event) => event.kind === "toolUse" && event.name === "Edit");
    expect(edit?.kind === "toolUse" && edit.parentToolUseId).toBeNull();
  });

  it("with --tools Read, Bash is not even available (BOM-prefixed fixture)", () => {
    const events = load("06-hard-allowlist");
    const init = events.find((event) => event.kind === "init");
    expect(init?.kind === "init" && init.tools).toEqual(["Read"]);
    expect(events.some((event) => event.kind === "toolUse" && event.name === "Bash")).toBe(false);
  });
});

describe("buildClaudeArgs", () => {
  it("restricts tools, skips MCP and never puts the prompt on the command line", () => {
    const args = buildClaudeArgs({
      cwd: ".",
      prompt: "secret prompt",
      model: "haiku",
      effort: "low",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash(git push *)"],
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Grep"]);
    expect(args).not.toContain("secret prompt");
  });

  it("uses --resume (with optional fork) instead of --session-id", () => {
    const args = buildClaudeArgs({
      cwd: ".",
      prompt: "",
      model: "sonnet",
      effort: "medium",
      tools: [],
      sessionId: "ignored",
      resume: "abc",
      forkSession: true,
    });
    expect(args).toEqual(expect.arrayContaining(["--resume", "abc", "--fork-session"]));
    expect(args).not.toContain("--session-id");
  });

  it("passes the repo's MCP servers in a temporary file (not in the args) and removes it afterwards", () => {
    const launch = claudeAdapter.launch({
      agent: "claude",
      cwd: ".",
      prompt: "",
      model: "haiku",
      effort: "low",
      tools: [],
      mcpConfig: { mcpServers: { "nexura-memory": { command: "node", args: ["m.ts"] } } },
      mcpServers: { docs: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer secret" } } },
    });
    const at = launch.args.indexOf("--mcp-config");
    expect(launch.args).toContain("--strict-mcp-config");
    expect(JSON.parse(launch.args[at + 1]!).mcpServers).toHaveProperty("nexura-memory");
    const file = launch.args[at + 2]!;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { docs: { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer secret" } } } });
    expect(launch.args.join(" ")).not.toContain("secret");
    launch.cleanup!();
    expect(existsSync(file)).toBe(false);
    expect(claudeAdapter.launch({ agent: "claude", cwd: ".", prompt: "", model: "haiku", effort: "low", tools: [] }).args).not.toContain("--mcp-config");
  });

  it("adds the memory server as the only MCP server of a memory step, with its tools pre-approved", () => {
    const context = { project: "sandbox", step: "plan", runId: "r1", allowedTools: ["Read"] };
    const memory = memoryRunOptions("read", context, "C:/data/memory.sqlite", REAL_CONFIG);
    const args = buildClaudeArgs({ cwd: ".", prompt: "", model: "haiku", effort: "low", tools: ["Read"], ...memory });
    expect(args).toContain("--strict-mcp-config");
    const server = (JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers[
      "nexura-memory"
    ]!;
    expect(server.command).toBe(process.execPath);
    expect(server.args.slice(2)).toEqual(["--db", "C:/data/memory.sqlite", "--mode", "read", "--project", "sandbox", "--source", "plan", "--run", "r1"]);
    expect(server.args[1]).toMatch(/mcp-server\.ts$/);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__nexura-memory__mem_search,mcp__nexura-memory__mem_get,mcp__nexura-memory__mem_context");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("mem_search");
    expect(args[args.indexOf("--append-system-prompt") + 1]).not.toContain("mem_save");
    expect(memoryProtocol("readwrite", REAL_CONFIG)).toContain("mem_save");
    expect(memoryRunOptions("readwrite", context)!.allowedTools).toContain("mcp__nexura-memory__mem_save");
    expect(memoryRunOptions("off", context)).toBeUndefined();
  });
});

describe("claudeEnv", () => {
  it("drops the launching session markers but keeps config and auth", () => {
    const env = claudeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_TOKEN: "x",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CONFIG_DIR: "C:/cfg",
      ANTHROPIC_API_KEY: "k",
      PATH: "p",
    });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "C:/cfg", ANTHROPIC_API_KEY: "k", PATH: "p" });
  });
});

describe("StreamUsage", () => {
  const assistant = (id: string, usage: Record<string, number>, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id, usage },
  });

  it("counts each message once, with its largest value per field", () => {
    const tracker = new StreamUsage();
    tracker.push(assistant("m1", { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }));
    tracker.push(assistant("m1", { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }));
    tracker.push(assistant("m2", { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, "toolu_1"));
    tracker.push({ type: "user", message: { id: "m3", usage: { input_tokens: 999 } } });
    expect(tracker.total()).toEqual({ inputTokens: 3, outputTokens: 45, cacheReadTokens: 300, cacheCreationTokens: 10, thinkingTokens: 0 });
  });

  it("measures the main agent's first call (cache read or written) and the context size at its last one", () => {
    const tracker = new StreamUsage();
    expect(tracker.firstCall()).toBeUndefined();
    expect(tracker.contextTokens()).toBeUndefined();
    tracker.push(assistant("m1", { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 800 }));
    tracker.push(assistant("sub", { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000 }, "toolu_1"));
    tracker.push(assistant("m2", { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 90_800, cache_creation_input_tokens: 1200 }));
    expect(tracker.firstCall()).toMatchObject({ cacheReadTokens: 90_000, cacheCreationTokens: 800 });
    // A subagent's own conversation is not the main context.
    expect(tracker.contextTokens()).toBe(7 + 90_800 + 1200);
  });

  it("reports only what the final result left out", () => {
    const observed = { inputTokens: 5, outputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 50, thinkingTokens: 0 };
    const reported = { inputTokens: 5, outputTokens: 200, cacheReadTokens: 300, cacheCreationTokens: 50, thinkingTokens: 0 };
    expect(usageBeyond(observed, reported)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 600, cacheCreationTokens: 0, thinkingTokens: 0 });
    expect(usageBeyond(observed, observed)).toBeUndefined();
    expect(usageBeyond(observed, undefined)).toEqual(observed);
  });

  it("finds nothing unreported in a complete recorded run", () => {
    const text = readFileSync(join(FIXTURES, "03-tool-use.jsonl"), "utf8");
    const tracker = new StreamUsage();
    let result: Record<string, number> | undefined;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const raw = parseLine(line);
      tracker.push(raw);
      if (raw?.type === "result") {
        result = raw.usage;
      }
    }
    const reported = { inputTokens: result!.input_tokens!, outputTokens: result!.output_tokens!, cacheReadTokens: result!.cache_read_input_tokens!, cacheCreationTokens: result!.cache_creation_input_tokens!, thinkingTokens: 0 };
    expect(usageBeyond(tracker.total(), reported)).toBeUndefined();
  });
});
