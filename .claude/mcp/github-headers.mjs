// headersHelper for the github MCP server: takes the token from the GitHub CLI login
// (`gh auth login --web`), so no personal access token has to be created or stored.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const candidates = ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"];
for (const gh of candidates) {
  if (gh !== "gh" && !existsSync(gh)) {
    continue;
  }
  try {
    const token = execFileSync(gh, ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (token) {
      console.log(JSON.stringify({ Authorization: `Bearer ${token}` }));
      process.exit(0);
    }
  } catch {
    // Not on PATH or not logged in: try the next one.
  }
}
console.error("GitHub CLI is not logged in: run `gh auth login --web`.");
process.exit(1);
