// Fake `claude -p` for the orchestrator tests: detects the step from the prompt and
// replays a minimal stream-json conversation. No network, no tokens.
//
// Env:
//   FAKE_STATE_DIR        where call counters are kept (required)
//   FAKE_REVIEW_REJECTS   how many times codeReview answers "changes" before approving
//   FAKE_FAIL_MARKER      if the prompt contains it, enrich fails (unless resumed/overridden)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const sessionId = randomUUID();
const stateDir = process.env.FAKE_STATE_DIR;
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function bump(step) {
  const file = join(stateDir, `${step}.count`);
  const count = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
  writeFileSync(file, String(count));
  return count;
}

function out(event) {
  process.stdout.write(JSON.stringify({ ...event, session_id: sessionId }) + "\n");
}

const resumed = args.includes("--resume");
const step = resumed
  ? "resumed"
  : prompt.startsWith("Clasifica")
    ? "classify"
    : (/paso \*\*(\w+)\*\*/.exec(prompt)?.[1] ?? "unknown");
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

let output;
let error;
switch (step) {
  case "classify":
    output = { profile: "minimal", reason: "fake: cambio pequeño" };
    break;
  case "enrich":
    if (process.env.FAKE_FAIL_MARKER && prompt.includes(process.env.FAKE_FAIL_MARKER)) {
      error = "fake enrich failure";
    }
    output = { summary: "fake", relevantFiles: [], conventions: ["Usa inject() en vez de constructores"], risks: [], openQuestions: [] };
    break;
  case "plan":
    output = { approach: "fake", changes: [], acceptanceCriteria: [{ description: "check", command: "npm run check" }] };
    break;
  case "implement":
    writeFileSync(join(process.cwd(), `impl-${count}.txt`), `implement ${count}\n`);
    writeFileSync(join(process.cwd(), "done.txt"), "ok\n");
    output = {
      summary: `implement ${count}`,
      commitMessage: `feat(fake): implement ${count}`,
      tasksDone: ["t1"],
      filesChanged: [`impl-${count}.txt`],
      notes: prompt.includes("[major]") ? "arreglado feedback" : "",
    };
    break;
  case "codeReview": {
    const rejects = Number(process.env.FAKE_REVIEW_REJECTS ?? 0);
    output =
      count <= rejects
        ? { verdict: "changes", summary: "fake", issues: [{ severity: "major", file: "x", problem: "p", fix: "f" }] }
        : { verdict: "approve", summary: "fake", issues: [] };
    break;
  }
  case "addressReview": {
    // Answers every "repo `x` · thread N" line of the prompt; fixes the first one in code.
    const threads = [...prompt.matchAll(/repo `([^`]+)` · thread (\d+)/g)].map((match) => ({ repo: match[1], threadId: Number(match[2]) }));
    writeFileSync(join(process.cwd(), `review-${count}.txt`), "fixed\n");
    output = {
      summary: `atendidos ${threads.length} hilos`,
      commitMessage: "fix(fake): address review",
      replies: [
        ...threads.map((thread, index) => ({ ...thread, reply: `respuesta ${thread.threadId}`, action: index === 0 ? "fixed" : "answered" })),
        { repo: "sandbox", threadId: 999, reply: "inventado", action: "fixed" },
      ],
    };
    break;
  }
  case "qaNotes":
    output = {
      summary: "fake",
      cases: [{ title: "Caso feliz", steps: ["Abrir la pantalla", "Pulsar el botón"], expected: "Se ve el cambio" }],
      risks: ["Estilos globales"],
    };
    break;
  case "resumed":
    output = { summary: "fake", relevantFiles: [], conventions: [], risks: [], openQuestions: [] };
    break;
  default:
    error = `fake: unknown step for prompt: ${prompt.slice(0, 80)}`;
}

out({ type: "assistant", message: { content: [{ type: "text", text: `fake ${step} #${count}` }] } });
out({
  type: "result",
  subtype: error ? "error_during_execution" : "success",
  is_error: Boolean(error),
  result: error ?? "ok",
  structured_output: error ? undefined : output,
  total_cost_usd: 0.01,
  num_turns: 1,
  duration_ms: 5,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  permission_denials: [],
});
