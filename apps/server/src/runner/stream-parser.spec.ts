import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NexuraEvent } from "@nexura/shared";
import { LineSplitter, normalize, parseLine } from "./stream-parser.ts";
import { buildClaudeArgs } from "./claude-args.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "stream");

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
});
