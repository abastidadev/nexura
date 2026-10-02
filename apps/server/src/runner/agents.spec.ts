import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NexuraEvent } from "@nexura/shared";
import type { AgentRunOptions } from "./agent-adapter.ts";
import { buildCodexArgs, codexAdapter, codexNormalizer, codexSandbox, parseCodexModels } from "./codex-adapter.ts";
import { copilotAdapter, copilotNormalizer, copilotPermissions, MAX_INLINE_PROMPT, parseCopilotModels } from "./copilot-adapter.ts";
import { checkJson, extractJson } from "./json-check.ts";
import { fromStrictOutput, toStrictSchema } from "./strict-schema.ts";
import { isMemoryWrite } from "../memory/memory.ts";

const PLAN_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "config", "steps", "plan", "schema.json"), "utf8"));

const base: AgentRunOptions = { agent: "codex", cwd: ".", prompt: "Eres el paso **plan**.", model: "gpt-5-codex", effort: "high", tools: ["Read", "Grep"] };

function resultOf(events: NexuraEvent[]): Extract<NexuraEvent, { kind: "result" }> {
  const result = events.find((event) => event.kind === "result");
  if (result?.kind !== "result") {
    throw new Error("no result event");
  }
  return result;
}

describe("strict schemas (codex --output-schema)", () => {
  it("makes every property required, optional ones nullable, and drops those nulls from the answer", () => {
    const strict = toStrictSchema(PLAN_SCHEMA);
    const criteria = strict.properties.acceptanceCriteria.items;
    expect(criteria.required).toEqual(["description", "command", "repo", "workdir"]);
    expect(criteria.properties.command.type).toEqual(["string", "null"]);
    expect(criteria.additionalProperties).toBe(false);
    // The original is untouched.
    expect(PLAN_SCHEMA.properties.acceptanceCriteria.items.required).toEqual(["description"]);

    const answer = { approach: "a", changes: [], acceptanceCriteria: [{ description: "d", command: null, repo: null, workdir: null }], conventions: [] };
    expect(fromStrictOutput(answer, PLAN_SCHEMA)).toEqual({ approach: "a", changes: [], acceptanceCriteria: [{ description: "d" }], conventions: [] });
    expect(checkJson(fromStrictOutput(answer, PLAN_SCHEMA), PLAN_SCHEMA)).toEqual([]);
  });
});

describe("checkJson / extractJson (copilot answers)", () => {
  it("reports missing, extra, mistyped and out-of-enum values", () => {
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["approve", "changes"] }, n: { type: "integer" } }, required: ["verdict", "n"], additionalProperties: false };
    expect(checkJson({ verdict: "approve", n: 1 }, schema)).toEqual([]);
    expect(checkJson({ verdict: "maybe", n: 1.5, extra: true }, schema)).toEqual([
      '$.verdict: "maybe" no es uno de "approve", "changes"',
      "$.n: se esperaba integer y llegó number",
      "$.extra: propiedad no permitida",
    ]);
    expect(checkJson({}, schema)).toEqual(["$.verdict: falta", "$.n: falta"]);
  });

  it("takes the last json block, or the last object of the text", () => {
    expect(extractJson('Primero {"a":1}\n\n```json\n{"b":2}\n```\nluego\n```json\n{"c":3}\n```')).toEqual({ c: 3 });
    expect(extractJson('Hecho. El resultado es {"ok": true, "n": {"x": 1}}')).toEqual({ ok: true, n: { x: 1 } });
    expect(extractJson("sin json")).toBeUndefined();
  });
});

describe("codex adapter", () => {
  it("pre-approves only allowed MCP tools on the servers injected for the step", () => {
    const args = buildCodexArgs({
      ...base,
      mcpConfig: { mcpServers: { "nexura-memory": { command: "node", args: ["server.ts", "--mode", "read"] } } },
      allowedTools: ["Read", "mcp__nexura-memory__mem_search", "mcp__nexura-memory__mem_save", "mcp__other__write", "mcp__nexura-memory__*", "mcp__nexura-memory__nested.key"],
      disallowedTools: ["mcp__nexura-memory__mem_save"],
    });
    expect(args.filter((arg) => arg.includes("approval_mode"))).toEqual([
      'mcp_servers.nexura-memory.tools.mem_search.approval_mode="approve"',
    ]);
    expect(buildCodexArgs(base).some((arg) => arg.includes("approval_mode"))).toBe(false);
  });

  it("builds exec args: model, effort, sandbox by tools, extra dirs, memory MCP, schema, resume and prompt on stdin", () => {
    expect(codexSandbox(["Read", "Bash"])).toBe("read-only");
    expect(codexSandbox(["Read", "Edit"])).toBe("workspace-write");
    const args = buildCodexArgs(
      { ...base, addDirs: ["C:\\other"], resume: "thread-1", mcpConfig: { mcpServers: { "nexura-memory": { command: "C:\\node.exe", args: ["server.ts", "--mode", "read"] } } } },
      "schema.json",
    );
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--skip-git-repo-check", "--model"]);
    expect(args).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="high"', "--sandbox", "read-only", "--add-dir", "C:\\other", "--output-schema", "schema.json"]));
    expect(args).toContain('mcp_servers.nexura-memory.command="C:\\\\node.exe"');
    expect(args).toContain('mcp_servers.nexura-memory.args=["server.ts","--mode","read"]');
    expect(args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
  });

  it("registers the repo's MCP servers too: stdio with env, http with url and headers", () => {
    const args = buildCodexArgs({
      ...base,
      mcpServers: {
        db: { command: "node", args: ["db.js"], env: { DB_URL: "postgres://x" } },
        docs: { type: "http", url: "https://mcp.example/docs", headers: { "X-Key": "k" } },
        "bad.name": { command: "x" },
      },
      allowedTools: ["mcp__db__query"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        'mcp_servers.db.command="node"',
        'mcp_servers.db.args=["db.js"]',
        'mcp_servers.db.env={ "DB_URL" = "postgres://x" }',
        'mcp_servers.db.tools.query.approval_mode="approve"',
        'mcp_servers.docs.url="https://mcp.example/docs"',
        'mcp_servers.docs.http_headers={ "X-Key" = "k" }',
      ]),
    );
    expect(args.some((arg) => arg.includes("bad.name"))).toBe(false);
  });

  it("writes a strict schema for the run and removes it afterwards; the memory protocol goes before the prompt", () => {
    const launch = codexAdapter.launch({ ...base, jsonSchema: PLAN_SCHEMA, appendSystemPrompt: "PROTOCOLO" });
    const schemaFile = launch.args[launch.args.indexOf("--output-schema") + 1]!;
    expect(JSON.parse(readFileSync(schemaFile, "utf8")).properties.acceptanceCriteria.items.required).toContain("command");
    expect(launch.stdin).toMatch(/^PROTOCOLO\n\n---\n\nEres el paso \*\*plan\*\*/);
    expect(launch.interactive).toBe(false);
    launch.cleanup!();
    expect(existsSync(schemaFile)).toBe(false);
  });

  it("maps thread/item/turn events: commands, file changes, MCP calls, reasoning and the JSON answer", () => {
    const { normalize, finish } = codexNormalizer({ jsonSchema: PLAN_SCHEMA });
    const answer = { approach: "a", changes: [], acceptanceCriteria: [{ description: "d", command: null }] };
    const events = [
      { type: "thread.started", thread_id: "t-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "0", type: "reasoning", text: "pienso" } },
      { type: "item.started", item: { id: "1", type: "command_execution", command: "git diff", status: "in_progress" } },
      { type: "item.completed", item: { id: "1", type: "command_execution", command: "git diff", aggregated_output: "boom", exit_code: 2, status: "failed" } },
      { type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "nexura-memory", tool: "mem_save", arguments: { title: "x" }, status: "completed", result: { content: [{ type: "text", text: "guardado" }] } } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: JSON.stringify(answer) } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } },
    ].flatMap((raw) => normalize(raw));

    expect(events[0]).toMatchObject({ kind: "init", sessionId: "t-1" });
    expect(events).toContainEqual({ kind: "thinking", text: "pienso" });
    expect(events).toContainEqual({ kind: "toolUse", id: "1", name: "Bash", input: { command: "git diff" }, parentToolUseId: null });
    expect(events).toContainEqual({ kind: "toolResult", toolUseId: "1", content: "boom\n(exit 2)", isError: true, parentToolUseId: null });
    const memorySave = events.find((event) => event.kind === "toolUse" && event.id === "2");
    expect(memorySave?.kind === "toolUse" && isMemoryWrite(memorySave.name)).toBe(true);
    const result = resultOf(events);
    expect(result).toMatchObject({ success: true, costUsd: 0, usage: { inputTokens: 6, cacheReadTokens: 4, outputTokens: 3, thinkingTokens: 1 } });
    expect(result.structuredOutput).toEqual({ approach: "a", changes: [], acceptanceCriteria: [{ description: "d" }] });
    expect(finish!(0, "")).toEqual([]);
  });

  it("fails with the turn's error (429 on usage limits) or on an exit without a finished turn", () => {
    const failed = codexNormalizer();
    expect(resultOf(failed.normalize({ type: "turn.failed", error: { message: "You've hit your usage limit" } }))).toMatchObject({ success: false, apiErrorStatus: 429 });
    const crashed = codexNormalizer();
    crashed.normalize({ type: "thread.started", thread_id: "t" });
    expect(resultOf(crashed.finish!(1, "Not logged in"))).toMatchObject({ success: false, text: expect.stringContaining("Not logged in") });
  });
});

describe("copilot adapter (checked against the real Copilot CLI 1.0.88)", () => {
  const STREAM = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "stream");
  const replay = (name: string, options: Parameters<typeof copilotNormalizer>[0] = {}, exitCode = 0): NexuraEvent[] => {
    const { normalize, finish } = copilotNormalizer(options);
    const lines = readFileSync(join(STREAM, name), "utf8").split(/\r?\n/).filter(Boolean);
    return [...lines.flatMap((line) => normalize(JSON.parse(line))), ...finish!(exitCode, "")];
  };

  it("lists the Codex account's models from `codex debug models`, without the hidden ones", () => {
    const catalog = { models: [{ slug: "gpt-6-sol", visibility: "list" }, { slug: "gpt-reserve", visibility: "hide" }, { slug: "gpt-5.5", visibility: "list" }, { visibility: "list" }] };
    expect(parseCodexModels(JSON.stringify(catalog))).toEqual(["gpt-6-sol", "gpt-5.5"]);
    expect(parseCodexModels("not json")).toEqual([]);
  });

  it("lists the installed CLI's models from `copilot help config`, plus auto", () => {
    const models = parseCopilotModels(readFileSync(join(STREAM, "10-copilot-help-config.txt"), "utf8"));
    expect(models).toContain("claude-sonnet-5");
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("gpt-5.5");
    expect(models).toContain("gemini-3.8-flash");
    expect(models.at(-1)).toBe("auto");
    expect(models).not.toContain("default");
    expect(parseCopilotModels("no model section here")).toEqual([]);
  });

  it("translates the step's permissions: denied kinds of tool, prefix rules with :*, MCP tools", () => {
    expect(copilotPermissions(["Read", "Grep"])).toEqual({ allow: [], deny: ["write", "shell"] });
    expect(
      copilotPermissions(
        ["Read", "Edit", "Write", "Bash"],
        ["Edit", "Write", "Bash(npm run *)", "Bash(git diff*)", "Bash(npm run check)", "mcp__nexura-memory__mem_save"],
        ["Bash(git push*)", "Bash(rm -rf*)"],
      ),
    ).toEqual({
      allow: ["write", "shell(npm run:*)", "shell(git diff:*)", "shell(npm run check)", "nexura-memory(mem_save)"],
      deny: ["shell(git push:*)", "shell(rm -rf:*)"],
    });
    // A shell rule on a step without Bash is not allowed.
    expect(copilotPermissions(["Read"], ["Bash(git diff*)"]).allow).toEqual([]);
  });

  it("builds the args: our session id (or --resume), effort, no built-in MCP unless asked, usage file; long prompts in a file", () => {
    const launch = copilotAdapter.launch({ ...base, agent: "copilot", model: "gpt-5-mini", jsonSchema: PLAN_SCHEMA, appendSystemPrompt: "PROTOCOLO" });
    const flag = (name: string): string | undefined => launch.args[launch.args.indexOf(name) + 1];
    expect(flag("-p")).toMatch(/^PROTOCOLO\n\n---\n\nEres el paso/);
    expect(flag("-p")).toContain("## Formato de la respuesta final");
    expect(launch.args).toEqual(expect.arrayContaining(["--output-format", "json", "--no-ask-user", "--disable-builtin-mcps"]));
    expect(flag("--reasoning-effort")).toBe("high");
    expect(flag("--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    const usageFile = flag("--usage-output-file")!;
    launch.cleanup!();
    expect(existsSync(join(usageFile, ".."))).toBe(false);

    const resumed = copilotAdapter.launch({
      ...base,
      agent: "copilot",
      resume: "s-1",
      mcpServers: { docs: { type: "http", url: "https://mcp.example/docs" }, db: { command: "node", args: ["db.js"] } },
      allowedTools: ["mcp__docs"],
    });
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe("s-1");
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.args).toContain("--disable-builtin-mcps");
    expect(JSON.parse(resumed.args[resumed.args.indexOf("--additional-mcp-config") + 1]!).mcpServers).toEqual({
      docs: { type: "http", url: "https://mcp.example/docs", tools: ["*"] },
      db: { type: "local", command: "node", args: ["db.js"], tools: ["*"] },
    });
    expect(resumed.args).toEqual(expect.arrayContaining(["--allow-tool", "docs"]));
    resumed.cleanup!();

    const long = copilotAdapter.launch({ ...base, agent: "copilot", prompt: "x".repeat(MAX_INLINE_PROMPT + 1) });
    const pointer = long.args[long.args.indexOf("-p") + 1]!;
    const file = /@(.+?) y sigue/.exec(pointer)![1]!;
    expect(readFileSync(file, "utf8")).toHaveLength(MAX_INLINE_PROMPT + 1);
    expect(long.args[long.args.indexOf("--add-dir") + 1]).toBe(join(file, ".."));
    long.cleanup!();
    expect(existsSync(file)).toBe(false);
  });

  it("replays a real run: tools as Write/Edit/Bash, a denied git push, reasoning, tokens from the usage file", () => {
    const events = replay("08-copilot-tools.jsonl", { sessionId: "11111111-2222-4333-8444-555555555555", model: "gpt-5-mini", usageFile: join(STREAM, "08-copilot-tools.usage.json") });
    expect(events[0]).toMatchObject({ kind: "init", sessionId: "11111111-2222-4333-8444-555555555555", model: "gpt-5-mini" });
    expect(events.filter((event) => event.kind === "init")).toHaveLength(1);
    expect(events.flatMap((event) => (event.kind === "toolUse" ? [event.name] : []))).toEqual(["Write", "Edit", "Bash"]);
    const denied = events.find((event) => event.kind === "toolResult" && event.isError);
    expect(denied?.kind === "toolResult" && denied.content).toContain("shell(git push:*)");
    // Ephemeral deltas and session noise never reach the timeline.
    expect(events.filter((event) => event.kind === "unknown")).toEqual([]);
    const result = resultOf(events);
    expect(result).toMatchObject({ success: true, numTurns: 2, costUsd: 0 });
    expect(result.usage.inputTokens + result.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("replays a real run with Nexura's memory MCP and takes its JSON answer (closing fence on the same line)", () => {
    const events = replay("09-copilot-mcp.jsonl", { jsonSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } });
    const search = events.find((event) => event.kind === "toolUse");
    expect(search).toMatchObject({ name: "mcp__nexura-memory__mem_search", input: { query: "badge" } });
    expect(resultOf(events)).toMatchObject({ success: true, structuredOutput: { n: 0 } });
  });

  it("fails on an answer that breaks the schema, on errors and on 429s", () => {
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["approve", "changes"] } }, required: ["verdict"], additionalProperties: false };
    const invalid = copilotNormalizer({ jsonSchema: schema });
    invalid.normalize({ type: "assistant.message", data: { content: '```json\n{"verdict":"maybe"}\n```' } });
    expect(resultOf(invalid.finish!(0, ""))).toMatchObject({ success: false, subtype: "invalid_structured_output", text: expect.stringContaining("no es uno de") });
    const crashed = copilotNormalizer();
    expect(resultOf(crashed.finish!(1, "Error: 429 Too Many Requests"))).toMatchObject({ success: false, apiErrorStatus: 429 });
    const errored = copilotNormalizer();
    errored.normalize({ type: "session.error", data: { message: "Not authenticated" } });
    expect(resultOf(errored.finish!(0, ""))).toMatchObject({ success: false, text: "Not authenticated" });
  });
});
