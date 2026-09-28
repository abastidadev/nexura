import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Worktree } from "@nexura/shared";
import { gitRaw } from "../workspace/git.ts";
import type { EmitFn, QaFailure } from "./builtin-steps.ts";

export type AutoFixResult = { repo: string; files: string[]; tools: string[] };

const FORMAT_CHECK = /\b(lint|eslint|prettier|prettify|format)\b/i;
const PRETTIER_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".css", ".scss", ".html", ".md", ".yaml", ".yml", ".vue", ".svelte"]);
const ESLINT_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

function inside(root: string, path: string): boolean {
  const distance = relative(root, path);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

/** Use only a package's installed CLI, never download a formatter or execute a shell-built filename. */
function localCli(cwd: string, root: string, name: "eslint" | "prettier"): string | undefined {
  let directory = cwd;
  while (inside(root, directory)) {
    const manifestFile = join(directory, "node_modules", name, "package.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { bin?: string | Record<string, string> };
        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
        if (bin) {
          const script = resolve(dirname(manifestFile), bin);
          if (inside(dirname(manifestFile), script) && existsSync(script)) {
            return script;
          }
        }
      } catch {
        return undefined;
      }
    }
    if (directory === root) {
      break;
    }
    directory = dirname(directory);
  }
  return undefined;
}

function runCli(script: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => done({ ok: !error, output: `${stdout}${stderr}`.slice(-2000) }));
  });
}

/** One bounded pass over changed files in the failing package, before asking implement to correct lint/format errors. */
export async function autoFixQaFailures(
  failures: (QaFailure & { cwd: string })[],
  worktrees: Worktree[],
  timeoutMs: number,
  emit: EmitFn,
): Promise<AutoFixResult[]> {
  const results: AutoFixResult[] = [];
  const seen = new Set<string>();
  for (const failure of failures.filter((item) => item.exitCode !== null && FORMAT_CHECK.test(item.command))) {
    const worktree = worktrees.find((item) => item.repo === failure.repo);
    if (!worktree) {
      continue;
    }
    const cwd = failure.cwd;
    const key = `${worktree.repo}\0${cwd}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const root = realpathSync(worktree.path);
    if (!inside(root, realpathSync(cwd))) {
      continue;
    }
    const changed = (await gitRaw(root, ["diff", "--name-only", "-z", worktree.baseRef, "--"])).split("\0").filter(Boolean);
    const files = changed.map((file) => resolve(root, file)).filter((file) => {
      if (!inside(root, file) || !inside(cwd, file) || !existsSync(file) || !statSync(file).isFile()) {
        return false;
      }
      return inside(root, realpathSync(file)) && PRETTIER_EXT.has(extname(file).toLowerCase());
    });
    if (!files.length) {
      continue;
    }
    const tools: string[] = [];
    for (const name of ["eslint", "prettier"] as const) {
      const script = localCli(cwd, root, name);
      const targets = name === "eslint" ? files.filter((file) => ESLINT_EXT.has(extname(file).toLowerCase())) : files;
      if (!script || !targets.length) {
        continue;
      }
      const flags = name === "eslint" ? ["--fix"] : ["--write", "--ignore-unknown"];
      const result = await runCli(script, [...flags, ...targets], cwd, Math.min(timeoutMs, 120_000));
      tools.push(name);
      emit({ kind: "text", text: `Autofix ${name} en ${worktree.repo} (${targets.length} fichero(s)): ${result.ok ? "terminado" : `salió con errores: ${result.output}`}` });
    }
    if (tools.length) {
      results.push({ repo: worktree.repo, files: files.map((file) => relative(root, file)), tools });
    }
  }
  return results;
}
