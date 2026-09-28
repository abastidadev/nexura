import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@nexura/shared";
import * as workspace from "../workspace/git.ts";
import { runQaCode } from "./builtin-steps.ts";

let root: string;
let worktree: Worktree;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nexura-qa-"));
  const path = join(root, "repo");
  mkdirSync(join(path, "frontend"), { recursive: true });
  writeFileSync(join(path, "frontend", "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }));
  worktree = { repo: "app", repoPath: path, path, branch: "test", baseRef: "main" };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const plan = (criterion: Record<string, unknown>) => ({ acceptanceCriteria: [{ description: "check", command: "npm run check", ...criterion }] });

describe("QA plan commands", () => {
  it("fixes changed files with an installed formatter, reruns QA and leaves untouched files alone", async () => {
    const repo = worktree.path;
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "node check.cjs" } }));
    writeFileSync(join(repo, "check.cjs"), "const fs = require('node:fs'); process.exit(fs.readFileSync('changed.ts', 'utf8') === 'fixed\\n' ? 0 : 1);\n");
    writeFileSync(join(repo, "changed.ts"), "before\n");
    writeFileSync(join(repo, "untouched.ts"), "leave me\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@nexura.local");
    git("config", "user.name", "nexura-test");
    git("add", "package.json", "check.cjs", "changed.ts", "untouched.ts");
    git("commit", "-q", "-m", "initial");
    worktree.baseRef = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "changed.ts"), "bad\n");
    const packageDir = join(repo, "node_modules", "prettier");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ bin: "bin.cjs" }));
    writeFileSync(join(packageDir, "bin.cjs"), "require('node:fs').writeFileSync(process.argv.at(-1), 'fixed\\n');\n");

    const result = await runQaCode([worktree], [{ name: "app", path: repo, baseBranch: "main", checks: ["npm run lint"] }], undefined, 10000, vi.fn());
    expect(result).toMatchObject({ passed: true, failures: [], autoFixes: [{ repo: "app", files: ["changed.ts"], tools: ["prettier"] }] });
    expect(readFileSync(join(repo, "changed.ts"), "utf8")).toBe("fixed\n");
    expect(readFileSync(join(repo, "untouched.ts"), "utf8")).toBe("leave me\n");
  });

  it("runs a real npm script in a nested package of the selected repo", async () => {
    const other = { ...worktree, repo: "other", path: root };
    const result = await runQaCode([other, worktree], [], plan({ repo: "app", workdir: "frontend" }), 10000, vi.fn());
    expect(result).toEqual({ passed: true, commands: 1, failures: [], configErrors: [] });
  });

  it("keeps old root commands and deduplicates configured checks", async () => {
    writeFileSync(join(worktree.path, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }));
    const shell = vi.spyOn(workspace, "runShell").mockResolvedValue({ command: "npm run check", exitCode: 0, output: "ok", timedOut: false });
    const repo = { name: "app", path: worktree.path, baseBranch: "main", checks: ["npm run check"] };
    const result = await runQaCode([worktree], [repo], plan({}), 1000, vi.fn());
    expect(result.commands).toBe(1);
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, /package.json/],
    [{ workdir: "frontend", command: "npm run missing" }, /no existe el script/],
    [{ repo: "unknown", workdir: "frontend" }, /repositorio.*desconocido/],
    [{ workdir: ".." }, /fuera del worktree/],
    [{ workdir: "missing" }, /no existe el directorio/],
    [{ workdir: "frontend", command: "npm run check && whoami" }, /no permitido/],
    [{ workdir: "frontend", command: "npm run check --workspace other" }, /selecciona el paquete/],
    [{ workdir: "frontend", command: "npm run check --prefix ../other" }, /selecciona el paquete/],
  ])("fails without running anything when the only command is invalid: %j", async (criterion, message) => {
    const shell = vi.spyOn(workspace, "runShell");
    await expect(runQaCode([worktree], [], plan(criterion), 1000, vi.fn())).rejects.toThrow(message);
    expect(shell).not.toHaveBeenCalled();
  });

  it("skips an invalid plan command but still runs the configured checks", async () => {
    const shell = vi.spyOn(workspace, "runShell").mockResolvedValue({ command: "npm run lint", exitCode: 0, output: "ok", timedOut: false });
    const emit = vi.fn();
    const repo = { name: "app", path: worktree.path, baseBranch: "main", checks: ["cd frontend && npm run lint"] };
    const result = await runQaCode([worktree], [repo], plan({ command: "npm run build-lib" }), 1000, emit);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(shell).toHaveBeenCalledWith("cd frontend && npm run lint", worktree.path, 1000);
    expect(result.passed).toBe(true);
    expect(result.configErrors).toEqual([{ repo: "app", command: "npm run build-lib", error: expect.stringMatching(/package.json/) }]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "text", text: expect.stringContaining("Se omite") }));
  });

  it("rejects absolute paths and junctions escaping the worktree", async () => {
    const shell = vi.spyOn(workspace, "runShell");
    symlinkSync(root, join(worktree.path, "outside"), "junction");
    for (const workdir of [resolve(worktree.path, "frontend"), "outside"]) {
      await expect(runQaCode([worktree], [], plan({ workdir }), 1000, vi.fn())).rejects.toThrow(/Configuración de QA/);
    }
    expect(shell).not.toHaveBeenCalled();
  });

  it("preserves real script failures as code feedback", async () => {
    vi.spyOn(workspace, "runShell").mockResolvedValue({ command: "npm run check", exitCode: 1, output: "assertion failed", timedOut: false });
    const result = await runQaCode([worktree], [], plan({ workdir: "frontend" }), 1000, vi.fn());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([{ repo: "app", command: "npm run check", exitCode: 1, outputTail: "assertion failed" }]);
  });

  it("does not report successful QA without any checks", async () => {
    await expect(runQaCode([worktree], [], undefined, 1000, vi.fn())).rejects.toThrow("QA sin verificar");
  });

  it("passes arguments to the script after the npm separator", async () => {
    const shell = vi.spyOn(workspace, "runShell").mockResolvedValue({ command: "npm run check -- --run", exitCode: 0, output: "ok", timedOut: false });
    await runQaCode([worktree], [], plan({ workdir: "frontend", command: "npm run check -- --run" }), 1000, vi.fn());
    expect(shell).toHaveBeenCalledWith("npm run check -- --run", expect.stringContaining("frontend"), 1000);
  });
});
