// Phase 0 spike: runs a few cheap `claude -p` calls and records their stream-json
// output as fixtures for the runner/parser tests. Uses haiku + low effort to spend
// as little of the Pro quota as possible.
//
//   npm run spike
//
// Output: fixtures/stream/<case>.jsonl + fixtures/stream/<case>.meta.json

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "stream");

function resolveClaudeBin(): string {
  if (process.env.NEXURA_CLAUDE_BIN) {
    return process.env.NEXURA_CLAUDE_BIN;
  }
  if (process.platform !== "win32") {
    return "claude";
  }
  // On Windows the npm shim is a .cmd/.ps1; spawn the real exe to avoid cmd.exe quoting.
  const shim = execFileSync("where.exe", ["claude.cmd"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();
  const exe = join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (!existsSync(exe)) {
    throw new Error(`claude.exe not found next to ${shim}; set NEXURA_CLAUDE_BIN`);
  }
  return exe;
}

type SpikeCase = {
  name: string;
  prompt: string;
  args: string[];
};

type SpikeResult = {
  name: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
  lines: number;
  eventTypes: Record<string, number>;
  sessionId?: string;
  stderr: string;
};

async function runCase(bin: string, spikeCase: SpikeCase): Promise<SpikeResult> {
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...spikeCase.args];
  const started = Date.now();
  const child = spawn(bin, args, { cwd: join(import.meta.dirname, ".."), stdio: ["pipe", "pipe", "pipe"] });

  // Prompt goes through stdin to avoid Windows command-line length and escaping issues.
  child.stdin.end(spikeCase.prompt);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const eventTypes: Record<string, number> = {};
  let sessionId: string | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string };
      const key = event.subtype ? `${event.type}/${event.subtype}` : String(event.type);
      eventTypes[key] = (eventTypes[key] ?? 0) + 1;
      sessionId ??= event.session_id;
    } catch {
      eventTypes["<invalid-json>"] = (eventTypes["<invalid-json>"] ?? 0) + 1;
    }
  }

  writeFileSync(join(FIXTURES_DIR, `${spikeCase.name}.jsonl`), lines.join("\n") + "\n");
  const result: SpikeResult = {
    name: spikeCase.name,
    args,
    exitCode,
    durationMs: Date.now() - started,
    lines: lines.length,
    eventTypes,
    sessionId,
    stderr,
  };
  writeFileSync(join(FIXTURES_DIR, `${spikeCase.name}.meta.json`), JSON.stringify(result, null, 2));
  return result;
}

const CHEAP = ["--model", "haiku", "--effort", "low"];

const classifySchema = JSON.stringify({
  type: "object",
  properties: {
    profile: { type: "string", enum: ["minimal", "standard", "full"] },
    reason: { type: "string" },
  },
  required: ["profile", "reason"],
  additionalProperties: false,
});

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const bin = resolveClaudeBin();
  console.log(`claude binary: ${bin}`);

  const results: SpikeResult[] = [];

  // 1. Plain text answer, no tools.
  results.push(
    await runCase(bin, {
      name: "01-plain",
      prompt: "Reply with exactly: NEXURA_OK",
      args: [...CHEAP, "--tools", ""],
    }),
  );

  // 2. Structured output forced by --json-schema (what classify/codeReview/qaCode will use).
  results.push(
    await runCase(bin, {
      name: "02-json-schema",
      prompt:
        "Classify this ticket into a flow profile. Ticket: 'Change the primary button colour from blue to green in the badge component.'",
      args: [...CHEAP, "--tools", "", "--json-schema", classifySchema],
    }),
  );

  // 3. Tool use with an allowlist: reads a file, so we get tool_use/tool_result events.
  results.push(
    await runCase(bin, {
      name: "03-tool-use",
      prompt: "Read package.json in the current directory and tell me the value of its name field. Nothing else.",
      args: [...CHEAP, "--allowedTools", "Read", "--permission-mode", "dontAsk"],
    }),
  );

  // 4. Denied tool: asks for Bash while only Read is allowed, to see how a denial looks.
  results.push(
    await runCase(bin, {
      name: "04-denied-tool",
      prompt: "Run the shell command `git status` and show me its output.",
      args: [...CHEAP, "--allowedTools", "Read", "--permission-mode", "dontAsk"],
    }),
  );

  // 5. Resume the session from case 1 (debug flow: "continue this session with an instruction").
  const firstSession = results[0]?.sessionId;
  if (firstSession) {
    results.push(
      await runCase(bin, {
        name: "05-resume",
        prompt: "What exact text did you reply with in your previous message?",
        args: [...CHEAP, "--tools", "", "--resume", firstSession],
      }),
    );
  }

  for (const result of results) {
    console.log(`\n== ${result.name}  exit=${result.exitCode}  ${result.durationMs}ms  lines=${result.lines}`);
    console.log(`   events: ${JSON.stringify(result.eventTypes)}`);
    if (result.stderr.trim()) {
      console.log(`   stderr: ${result.stderr.trim().slice(0, 500)}`);
    }
  }
}

await main();
