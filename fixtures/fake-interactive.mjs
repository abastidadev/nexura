// Interactive mode of the fake agents (launched without -p / exec, as Nexura's terminal
// conversations do): a tiny line-based REPL that answers every message and writes the
// session transcript where the real CLI would, in its format, so conversations can resume
// and hand over between agents without tokens:
//   claude   $CLAUDE_CONFIG_DIR/projects/<cwd slug>/<id>.jsonl
//   codex    $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (+ session_index.jsonl)
//   copilot  $COPILOT_HOME/session-state/<id>/events.jsonl
// Nothing is written unless that variable is set: the fakes never touch the real ~/.claude,
// ~/.codex or ~/.copilot. "exit" ends the session.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const NAMES = { claude: "Claude Code", codex: "Codex", copilot: "Copilot" };
/** Flags that take a value, per CLI (everything else is a switch or a positional). */
const VALUE_FLAGS = {
  claude: ["--model", "--effort", "--permission-mode", "--session-id", "--resume", "--add-dir", "--name"],
  codex: ["--model", "-m", "-c", "--sandbox", "-s", "--ask-for-approval", "-a", "--add-dir"],
  copilot: ["--model", "--reasoning-effort", "--session-id", "--resume", "--add-dir", "--allow-tool", "-i", "--mode"],
};
const MODE_FLAGS = ["--permission-mode", "--dangerously-skip-permissions", "--sandbox", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--plan", "--autopilot", "--yolo", "--allow-tool"];

function parse(agent, args) {
  const flags = {};
  const positionals = [];
  const modes = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (VALUE_FLAGS[agent].includes(arg)) {
      flags[arg] = args[++index];
      if (MODE_FLAGS.includes(arg)) {
        modes.push(`${arg} ${flags[arg]}`);
      }
    } else if (arg.startsWith("-") && !arg.startsWith(" ")) {
      flags[arg] = true;
      if (MODE_FLAGS.includes(arg)) {
        modes.push(arg);
      }
    } else {
      positionals.push(arg.trim());
    }
  }
  return { flags, positionals, modes };
}

const stamp = () => new Date().toISOString();

function transcript(agent, sessionId, cwd) {
  const home = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, copilot: process.env.COPILOT_HOME }[agent];
  if (!home) {
    return { file: undefined, previous: 0, write() {}, title() {} };
  }
  let file;
  if (agent === "claude") {
    file = join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  } else if (agent === "copilot") {
    file = join(home, "session-state", sessionId, "events.jsonl");
  } else {
    file = findRollout(home, sessionId);
    if (!file) {
      const date = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const day = join(home, "sessions", String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
      const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
      file = join(day, `rollout-${time}-${sessionId}.jsonl`);
    }
  }
  const exists = existsSync(file);
  const previous = exists ? readFileSync(file, "utf8").split("\n").filter((line) => /user_message|"type":"user"|user\.message/.test(line)).length : 0;
  mkdirSync(dirname(file), { recursive: true });
  const line = (value) => appendFileSync(file, JSON.stringify(value) + "\n");
  if (!exists && agent === "codex") {
    line({ timestamp: stamp(), type: "session_meta", payload: { id: sessionId, cwd, timestamp: stamp(), cli_version: "fake" } });
  }
  if (!exists && agent === "copilot") {
    line({ type: "session.start", data: { sessionId, copilotVersion: "fake" }, id: randomUUID(), timestamp: stamp() });
  }
  return {
    file,
    previous,
    write(role, text) {
      const timestamp = stamp();
      if (agent === "claude") {
        line(
          role === "user"
            ? { type: "user", message: { role: "user", content: text }, timestamp, sessionId, cwd }
            : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp, sessionId, cwd },
        );
      } else if (agent === "codex") {
        line({ timestamp, type: "event_msg", payload: role === "user" ? { type: "user_message", message: text } : { type: "agent_message", message: text } });
      } else {
        line({ type: role === "user" ? "user.message" : "assistant.message", data: role === "user" ? { content: text } : { content: text, toolRequests: [] }, id: randomUUID(), timestamp });
      }
    },
    title(text) {
      const title = `Fake: ${text.slice(0, 40)}`;
      if (agent === "claude") {
        line({ type: "ai-title", aiTitle: title, sessionId });
      } else if (agent === "codex") {
        appendFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: title, updated_at: stamp() }) + "\n");
      }
    },
  };
}

function findRollout(home, sessionId) {
  const root = join(home, "sessions");
  const walk = (dir) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found) {
          return found;
        }
      } else if (entry.name.endsWith(`-${sessionId}.jsonl`)) {
        return path;
      }
    }
    return undefined;
  };
  return walk(root);
}

/** The answer to one message: a handoff prompt makes it read the history file it points to. */
function answer(agent, text) {
  if (text.startsWith("[Nexura · traspaso]")) {
    const file = /"([^"]+\.md)"/.exec(text)?.[1];
    const history = file && existsSync(file) ? readFileSync(file, "utf8") : "";
    const messages = (history.match(/^### /gm) ?? []).length;
    const instruction = text.includes("Lo que te pido ahora:");
    return `He leído el historial (${messages} mensajes${instruction ? ", con una instrucción nueva" : ""}). Sigo donde se quedó.`;
  }
  return `fake-${agent} recibió: «${text}»`;
}

export async function interactive(agent, args) {
  const { flags, positionals, modes } = parse(agent, args);
  const resumed = agent === "codex" ? positionals[0] === "resume" : Boolean(flags["--resume"]);
  let sessionId;
  let prompt;
  if (agent === "codex") {
    const rest = positionals[0] === "resume" ? positionals.slice(1) : positionals;
    sessionId = resumed ? rest.shift() : randomUUID();
    prompt = rest[0];
  } else {
    sessionId = flags["--resume"] ?? flags["--session-id"] ?? randomUUID();
    prompt = agent === "copilot" ? flags["-i"]?.trim() : positionals[0];
  }
  const session = transcript(agent, sessionId, process.cwd());
  const model = flags["--model"] ?? flags["-m"] ?? "por defecto";
  process.stdout.write(`\x1b[1mFake ${NAMES[agent]}\x1b[0m · modelo ${model} · modo ${modes.join(" ") || "por defecto"} · sesión ${sessionId}\r\n`);
  if (resumed) {
    process.stdout.write(`(sesión reanudada: ${session.previous} mensajes previos)\r\n`);
  }
  if (!session.file) {
    process.stdout.write("(sin transcripción: define CLAUDE_CONFIG_DIR, CODEX_HOME o COPILOT_HOME)\r\n");
  }
  let first = session.previous === 0;
  const handle = (text) => {
    session.write("user", text);
    if (first) {
      session.title(text);
      first = false;
    }
    const reply = answer(agent, text);
    session.write("assistant", reply);
    process.stdout.write(`${reply}\r\n`);
  };
  if (prompt) {
    process.stdout.write(`> ${prompt}\r\n`);
    handle(prompt);
  }
  process.stdout.write("> ");
  for await (const raw of createInterface({ input: process.stdin })) {
    const text = raw.trim();
    if (text === "exit" || text === "/exit") {
      break;
    }
    if (text) {
      handle(text);
    }
    process.stdout.write("> ");
  }
}
