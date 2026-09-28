// Fake `claude -p` for the orchestrator tests: detects the step from the prompt and
// replays a minimal stream-json conversation. No network, no tokens.
//
// Env (plus the shared ones in fake-steps.mjs: FAKE_STATE_DIR, FAKE_REVIEW_*, FAKE_FAIL_MARKER, FAKE_DELAY_MS):
//   FAKE_WAIT_MESSAGE     enrich or implement waits for a second stdin message and puts it in its summary
//   FAKE_SUBAGENTS        implement launches an Explore subagent (Agent tool) before editing
//   FAKE_CONTEXT_TOKENS   size of the conversation each answer reports (default 1000)
//   FAKE_CACHE_MISS       a resumed session writes its conversation into the cache instead of reading it
//
// Each call costs $0.01 but, like the real CLI, a resumed (or forked) session reports its whole cost.
//
// Like the real CLI with `--input-format stream-json`: user messages arrive as JSON lines
// on stdin, and the process only exits once stdin is closed after the result.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bump, detectStep, pause, stateDir, stepAnswer } from "./fake-steps.mjs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0 (fake Claude Code)");
  process.exit(0);
}
if (!args.includes("-p")) {
  // Interactive TUI (terminal conversations): see fake-interactive.mjs.
  const { interactive } = await import("./fake-interactive.mjs");
  await interactive("claude", args);
  process.exit(0);
}
if (args[args.indexOf("-p") + 1] === "/usage") {
  process.stdout.write(JSON.stringify({
    result: "Current session: 0% used\nCurrent week (all models): 0% used",
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  process.exit(0);
}
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function nextMessage() {
  const { value, done } = await lines.next();
  return done ? "" : JSON.parse(value).message.content;
}
const prompt = await nextMessage();
const sessionId = args.includes("--resume") && !args.includes("--fork-session") ? args[args.indexOf("--resume") + 1] : randomUUID();
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function out(event) {
  process.stdout.write(JSON.stringify({ ...event, session_id: sessionId }) + "\n");
}

const step = detectStep(prompt, args.includes("--resume"));
const count = bump(step);

out({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  tools: (argValue("--tools") ?? "").split(",").filter(Boolean),
  model: argValue("--model"),
  claude_code_version: "fake",
});
out({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: 0,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 0 }, seven_day: { utilization: 0.2, resetsAt: 0 } },
  },
});

if (step === "implement" && process.env.FAKE_SUBAGENTS) {
  await subagent();
}
// A phase of the main session gets one schema for all phases and answers under its own key.
const phaseKey = /en la clave `(\w+)` de StructuredOutput/.exec(prompt)?.[1];
const schema = args.includes("--json-schema") ? JSON.parse(argValue("--json-schema")) : undefined;
const phaseSchema = phaseKey ? schema?.properties?.[phaseKey] : schema;
const answer = stepAnswer({ step, count, prompt, hasSchema: Boolean(phaseSchema) && phaseSchema.type !== "string" });
const { error, text: resultText } = answer;
const output = phaseKey && !error ? { [phaseKey]: answer.output ?? answer.text } : answer.output;
if ((step === "enrich" || step === "implement") && process.env.FAKE_WAIT_MESSAGE) {
  out({ type: "assistant", message: { content: [{ type: "text", text: "esperando mensaje" }] } });
  (phaseKey ? output[phaseKey] : output).summary = `fake + ${await nextMessage()}`;
}

// Like the real API: a resumed session reads its conversation from the cache, a new one writes it.
const contextTokens = Number(process.env.FAKE_CONTEXT_TOKENS ?? 1000);
const cached = args.includes("--resume") && !process.env.FAKE_CACHE_MISS;
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: cached ? contextTokens : 0,
  cache_creation_input_tokens: cached ? 50 : contextTokens,
};

const sessionCostFile = (id) => join(stateDir, `session-${id}.cost`);
const resumedFrom = args.includes("--resume") ? sessionCostFile(argValue("--resume")) : undefined;
const totalCost = (resumedFrom && existsSync(resumedFrom) ? Number(readFileSync(resumedFrom, "utf8")) : 0) + 0.01;
writeFileSync(sessionCostFile(sessionId), String(totalCost));

await pause();
out({ type: "assistant", message: { id: `msg_${step}_${count}`, content: [{ type: "text", text: `fake ${step} #${count}` }], usage } });
out({
  type: "result",
  subtype: error ? "error_during_execution" : "success",
  is_error: Boolean(error),
  result: error ?? resultText,
  structured_output: error ? undefined : output,
  total_cost_usd: totalCost,
  num_turns: 1,
  duration_ms: 5,
  usage,
  permission_denials: [],
});

/** An Agent tool use, the subagent's own tool calls (tagged with parent_tool_use_id) and its result. */
async function subagent() {
  const agentId = `toolu_agent_${count}`;
  const assistant = (content, parent = null) => out({ type: "assistant", message: { content }, parent_tool_use_id: parent });
  const user = (content, parent = null) => out({ type: "user", message: { content }, parent_tool_use_id: parent });
  assistant([{ type: "thinking", thinking: "Delego la búsqueda" }]);
  await pause();
  assistant([{ type: "tool_use", id: agentId, name: "Agent", input: { description: "Buscar dónde tocar", subagent_type: "Explore", prompt: "Localiza el código" } }]);
  const calls = [
    ["Grep", { pattern: "badge" }],
    ["Read", { file_path: join(process.cwd(), "package.json") }],
    ["Bash", { command: "git log --oneline -5" }],
  ];
  for (const [index, [name, input]] of calls.entries()) {
    await pause();
    assistant([{ type: "tool_use", id: `${agentId}_${index}`, name, input }], agentId);
    await pause();
    user([{ type: "tool_result", tool_use_id: `${agentId}_${index}`, content: "ok" }], agentId);
  }
  await pause();
  user([{ type: "tool_result", tool_use_id: agentId, content: [{ type: "text", text: "Hay que tocar package.json" }] }]);
  await pause();
  assistant([{ type: "tool_use", id: `toolu_edit_${count}`, name: "Edit", input: { file_path: join(process.cwd(), "done.txt") } }]);
  await pause();
  user([{ type: "tool_result", tool_use_id: `toolu_edit_${count}`, content: "ok" }]);
}

// Drain stdin: the runner closes it after the result.
while (!(await lines.next()).done);
