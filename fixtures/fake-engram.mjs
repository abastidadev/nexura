// Fake `engram` CLI for the tests: never touches the real ~/.engram. Every call is
// appended to $FAKE_STATE_DIR/engram.jsonl as { cwd, args }, and saves are kept so
// `context` / `search` return them.
//
// Env:
//   FAKE_STATE_DIR   where the call log and saved observations are kept (required)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_STATE_DIR;
const log = join(stateDir, "engram.jsonl");
appendFileSync(log, JSON.stringify({ cwd: process.cwd(), args }) + "\n");

const saves = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((call) => call.args[0] === "save")
        .map((call) => {
          const positionals = call.args.slice(call.args.indexOf("--") + 1);
          return { title: positionals[0], content: positionals[1] };
        })
    : [];

switch (args[0]) {
  case "version":
    console.log("engram 0.0.0-fake");
    break;
  case "save":
    console.log(`Memory saved: #${saves().length}`);
    break;
  case "context": {
    const all = saves();
    console.log(
      all.length
        ? `## Memory from Previous Sessions\n\n### Recent Observations\n${all.map((save) => `- **${save.title}**: ${save.content.slice(0, 80)}`).join("\n")}`
        : "No previous session memories found.",
    );
    break;
  }
  case "search": {
    const words = args[1].toLowerCase().split(/\W+/).filter((word) => word.length > 3);
    const found = saves().filter((save) => words.some((word) => save.title.toLowerCase().includes(word)));
    console.log(found.length ? `Found ${found.length} memories:\n\n${found.map((save, i) => `[${i + 1}] ${save.title}`).join("\n")}` : `No memories found for: "${args[1]}"`);
    break;
  }
  default:
    process.exitCode = 1;
}
