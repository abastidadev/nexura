// Fake `claude -p` for the orchestrator tests: detects the step from the prompt and
// replays a minimal stream-json conversation. No network, no tokens.
//
// Env (plus the shared ones in fake-steps.mjs: FAKE_STATE_DIR, FAKE_REVIEW_*, FAKE_FAIL_MARKER, FAKE_DELAY_MS):
//   FAKE_WAIT_MESSAGE     enrich waits for a second stdin message and puts it in its summary
//   FAKE_SUBAGENTS        implement launches an Explore subagent (Agent tool) before editing
//
// Like the real CLI with `--input-format stream-json`: user messages arrive as JSON lines
// on stdin, and the process only exits once stdin is closed after the result.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { bump, detectStep, pause, stepAnswer } from "./fake-steps.mjs";

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
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function nextMessage() {
  const { value, done } = await lines.next();
  return done ? "" : JSON.parse(value).message.content;
}
const prompt = await nextMessage();
const sessionId = randomUUID();
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
const { output, error, text: resultText } = stepAnswer({ step, count, prompt, hasSchema: args.includes("--json-schema") });
if (step === "enrich" && process.env.FAKE_WAIT_MESSAGE) {
  out({ type: "assistant", message: { content: [{ type: "text", text: "esperando mensaje" }] } });
  output.summary = `fake + ${await nextMessage()}`;
}

await pause();
out({ type: "assistant", message: { content: [{ type: "text", text: `fake ${step} #${count}` }] } });
out({
  type: "result",
  subtype: error ? "error_during_execution" : "success",
  is_error: Boolean(error),
  result: error ?? resultText,
  structured_output: error ? undefined : output,
  total_cost_usd: 0.01,
  num_turns: 1,
  duration_ms: 5,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
