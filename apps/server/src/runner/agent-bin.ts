import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentCommand } from "./agent-adapter.ts";

/** First match of `where.exe`, or undefined when there is none. */
export function whereFirst(name: string): string | undefined {
  try {
    return execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0]!.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** An override path: a .js/.mjs script runs with node (the fake CLIs of the tests), anything else as is. */
export function overrideCommand(path: string): AgentCommand {
  return /\.m?js$/.test(path) ? { command: process.execPath, prefixArgs: [path] } : { command: path, prefixArgs: [] };
}

/**
 * A CLI installed with `npm install -g <pkg>`: on Windows the shim is a .cmd, and spawning
 * it would go through cmd.exe quoting (prompts with quotes and newlines break). So run the
 * package's bin script with node instead, or a native `<name>.exe` on the PATH, or the one
 * winget installed (`wingetId`), which a server started before the install has no PATH for.
 * Undefined when it is not installed.
 */
export function resolveNpmCli(name: string, pkg: string, wingetId?: string): AgentCommand | undefined {
  if (process.platform !== "win32") {
    return { command: name, prefixArgs: [] };
  }
  const shim = whereFirst(`${name}.cmd`);
  if (shim) {
    const packageDir = join(dirname(shim), "node_modules", ...pkg.split("/"));
    const script = binScript(packageDir, name);
    if (script) {
      return { command: process.execPath, prefixArgs: [script] };
    }
  }
  const exe = whereFirst(`${name}.exe`) ?? (wingetId ? wingetExe(wingetId, `${name}.exe`) : undefined);
  return exe ? { command: exe, prefixArgs: [] } : undefined;
}

/** `%LOCALAPPDATA%\Microsoft\WinGet\{Links,Packages\<id>_*}\<exe>`. */
function wingetExe(id: string, exe: string): string | undefined {
  const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet") : undefined;
  if (!root) {
    return undefined;
  }
  const link = join(root, "Links", exe);
  if (existsSync(link)) {
    return link;
  }
  try {
    const packages = join(root, "Packages");
    const folder = readdirSync(packages).find((entry) => entry.startsWith(`${id}_`) && existsSync(join(packages, entry, exe)));
    return folder ? join(packages, folder, exe) : undefined;
  } catch {
    return undefined;
  }
}

function binScript(packageDir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
    const script = relative ? join(packageDir, relative) : undefined;
    return script && existsSync(script) ? script : undefined;
  } catch {
    return undefined;
  }
}
