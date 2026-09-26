// Fake `copilot -p ... --output-format json` for the tests, with the event format of the
// real Copilot CLI 1.0.88: no start event, ephemeral noise, tool.execution_* events,
// assistant.message and a final `result` with the session id. Tokens go only to
// --usage-output-file. Takes the prompt from -p (or the @file it points to) and answers
// each Nexura step (fake-steps.mjs), ending with a ```json block when the prompt asks for
// one. No network, no tokens.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { bump, detectStep, pause, recordCall, stepAnswer } from "./fake-steps.mjs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("GitHub Copilot CLI 0.0.0-fake.");
  process.exit(0);
}
if (args[0] === "help" && args[1] === "config") {
  // Same shape as the real `copilot help config` (see fixtures/stream/10-copilot-help-config.txt).
  console.log('  `model`: AI model to use for Copilot CLI.\n    - "fake-sonnet"\n    - "fake-gpt"\n');
  process.exit(0);
}
if (!args.includes("-p")) {
  // Interactive TUI (terminal conversations): see fake-interactive.mjs.
  const { interactive } = await import("./fake-interactive.mjs");
  await interactive("copilot", args);
  process.exit(0);
}
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
let prompt = argValue("-p") ?? "";
const file = /^Lee el fichero @(.+?) y sigue/.exec(prompt)?.[1];
if (file) {
  prompt = readFileSync(file, "utf8");
}
const out = (type, data, extra = {}) => process.stdout.write(JSON.stringify({ type, data, id: randomUUID(), timestamp: new Date().toISOString(), ...extra }) + "\n");
const sessionId = argValue("--resume") ?? argValue("--session-id") ?? randomUUID();
const model = argValue("--model");

const step = detectStep(prompt, args.includes("--resume"));
const count = bump(step);
recordCall("copilot", step, count, args, prompt);
const wantsJson = prompt.includes("## Formato de la respuesta final");

out("session.mcp_server_status_changed", { serverName: "github-mcp-server", status: "pending" }, { ephemeral: true });
out("session.tools_updated", { model }, { ephemeral: true });
out("user.message", { content: prompt.slice(0, 40) });
out("assistant.turn_start", { turnId: "0" });
const { output, error, text } = stepAnswer({ step, count, prompt, hasSchema: wantsJson });
await pause();
out("assistant.message_delta", { messageId: "m0", deltaContent: "Mir" }, { ephemeral: true });
out("assistant.message", {
  messageId: "m0",
  model,
  content: "Miro el estado del repo.",
  reasoningText: `Pienso en ${step}`,
  toolRequests: [{ toolCallId: "call_1", name: "powershell", arguments: { command: "git --no-pager status" } }],
});
out("tool.execution_start", { toolCallId: "call_1", toolName: "powershell", arguments: { command: "git --no-pager status" }, model });
out("tool.execution_complete", { toolCallId: "call_1", success: true, result: { content: "nothing to commit" }, model });
out("assistant.turn_end", { turnId: "0" });
await pause();
if (error) {
  out("session.error", { errorType: "fake", message: error });
  out("result", undefined, { sessionId, exitCode: 1, usage: { premiumRequests: 0 } });
  process.exit(1);
}
out("assistant.turn_start", { turnId: "1" });
const fence = "```";
out("assistant.message", { messageId: "m1", model, content: wantsJson ? `Hecho.\n\n${fence}json\n${JSON.stringify(output, null, 2)}\n${fence}` : text, toolRequests: [] });
out("assistant.turn_end", { turnId: "1" });
out("session.usage_checkpoint", { totalPremiumRequests: 1 });
out("assistant.idle", {}, { ephemeral: true });
out("result", undefined, { sessionId, exitCode: 0, usage: { premiumRequests: 1 } });
const usageFile = argValue("--usage-output-file");
if (usageFile) {
  const usage = { inputTokens: 90, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 4 };
  writeFileSync(usageFile, JSON.stringify({ totalPremiumRequestCost: 1, modelMetrics: { [model]: { requests: { count: 2, cost: 1 }, usage } } }));
}
