// Fake `codex exec --json` for the tests: reads the prompt from stdin (`-`) and answers each
// Nexura step (fake-steps.mjs) with thread/turn/item JSONL events. No network, no tokens.
// The structured answer is the last agent message, as JSON, when --output-schema is given.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { bump, detectStep, pause, recordCall, stepAnswer } from "./fake-steps.mjs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const resumeIndex = args.indexOf("resume");
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();
const schemaFile = args.includes("--output-schema") ? args[args.indexOf("--output-schema") + 1] : undefined;

const step = detectStep(prompt, resumeIndex >= 0);
const count = bump(step);
recordCall("codex", step, count, args, prompt);

out({ type: "thread.started", thread_id: threadId });
out({ type: "turn.started" });
await pause();
out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: `**Pensando en ${step}**` } });

if (schemaFile) {
  // The real codex rejects non-strict schemas: fail the same way if one slips through.
  const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  if (schema.additionalProperties !== false || Object.keys(schema.properties ?? {}).some((key) => !schema.required?.includes(key))) {
    out({ type: "turn.failed", error: { message: "invalid_json_schema: strict mode needs every property required" } });
    process.exit(1);
  }
}

const { output, error, text } = stepAnswer({ step, count, prompt, hasSchema: Boolean(schemaFile) });
if (step === "implement") {
  const command = "bash -lc 'npm run check'";
  await pause();
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" } });
  await pause();
  out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command, aggregated_output: "ok\n", exit_code: 0, status: "completed" } });
  out({
    type: "item.completed",
    item: { id: "item_2", type: "file_change", changes: [{ path: `impl-${count}.txt`, kind: "add" }, { path: "done.txt", kind: "update" }], status: "completed" },
  });
}
await pause();
if (error) {
  out({ type: "turn.failed", error: { message: error } });
  process.exit(1);
}
out({ type: "item.completed", item: { id: "item_9", type: "agent_message", text: schemaFile ? JSON.stringify(output) : text } });
out({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } });
