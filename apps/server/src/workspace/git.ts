import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig, Worktree } from "@nexura/shared";
import { forgetWorktree, trustWorktree } from "./claude-trust.ts";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "task"
  );
}

/**
 * Creates `<repo>.worktrees/nexura-<runId>` on a new branch off the base branch
 * (origin/<base> when it exists, so the run starts from the latest remote state).
 */
export async function createWorktree(repo: RepoConfig, runId: string, branchName: string): Promise<Worktree> {
  try {
    await git(repo.path, ["fetch", "--quiet", "origin", repo.baseBranch]);
  } catch {
    // Offline or no remote: fall back to the local branch.
  }
  const baseRef = (await refExists(repo.path, `origin/${repo.baseBranch}`)) ? `origin/${repo.baseBranch}` : repo.baseBranch;
  const path = join(`${repo.path}.worktrees`, `nexura-${runId}`);
  await git(repo.path, ["worktree", "add", "-b", branchName, path, baseRef]);

  const mode = repo.nodeModules ?? "link";
  const source = join(repo.path, "node_modules");
  if (mode === "link" && existsSync(source)) {
    // A junction needs no admin rights on Windows and is ignored by git (node_modules is gitignored).
    symlinkSync(source, join(path, "node_modules"), "junction");
  } else if (mode === "install") {
    await runShell("npm ci", path, 20 * 60 * 1000);
  }
  trustWorktree(path);
  return { repo: repo.name, repoPath: repo.path, path, branch: branchName, baseRef };
}

export async function removeWorktree(worktree: Worktree, deleteBranch = false): Promise<void> {
  // Unlink the node_modules junction first so nothing recurses into the main checkout.
  const link = join(worktree.path, "node_modules");
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
    unlinkSync(link);
  }
  await git(worktree.repoPath, ["worktree", "remove", "--force", worktree.path]);
  forgetWorktree(worktree.path);
  if (deleteBranch) {
    await git(worktree.repoPath, ["branch", "-D", worktree.branch]);
  }
}

/** Stages everything and commits. Returns the new SHA, or undefined when there was nothing to commit. */
export async function commitAll(worktree: Worktree, message: string): Promise<string | undefined> {
  await git(worktree.path, ["add", "-A"]);
  // Belt and braces: never commit the node_modules junction, even if a repo does not ignore it.
  await git(worktree.path, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules"]);
  const staged = await git(worktree.path, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    return undefined;
  }
  await git(worktree.path, ["commit", "-q", "-m", message]);
  return git(worktree.path, ["rev-parse", "HEAD"]);
}

export type ShellResult = { command: string; exitCode: number | null; output: string; timedOut: boolean };

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ command, exitCode, output, timedOut });
    });
  });
}
