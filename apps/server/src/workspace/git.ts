import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  const branch = await freeBranchName(repo.path, branchName);
  await git(repo.path, ["worktree", "add", "-b", branch, path, baseRef]);

  const mode = repo.nodeModules ?? "link";
  if (mode === "link" && existsSync(join(repo.path, "node_modules"))) {
    linkNodeModules(repo.path, path);
  } else if (mode === "install") {
    await runShell("npm ci", path, 20 * 60 * 1000);
  }
  trustWorktree(path);
  return { repo: repo.name, repoPath: repo.path, path, branch, baseRef };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Reuses the main checkout's installed dependencies without an install. node_modules is a
 * real directory of junctions (junctions need no admin rights on Windows and node_modules is
 * gitignored) rather than one junction to the whole folder, so that npm workspace packages
 * (`node_modules/@scope/web` → `apps/web`) point at the worktree's own copy instead of the
 * main checkout's. Each workspace's own node_modules (dependencies npm did not hoist) is
 * linked as well.
 */
export function linkNodeModules(repoPath: string, worktreePath: string): void {
  const repoReal = realpathSync(repoPath);
  const source = join(repoPath, "node_modules");
  const target = join(worktreePath, "node_modules");
  const workspaces = new Set<string>();

  const linkEntry = (from: string, to: string): void => {
    if (!lstatSync(from).isSymbolicLink()) {
      symlinkSync(from, to, "junction");
      return;
    }
    let real: string;
    try {
      real = realpathSync(from);
    } catch {
      return; // Dangling link in the main checkout.
    }
    if (!statSync(real).isDirectory()) {
      return; // Junctions only point at directories.
    }
    if (!isInside(repoReal, real)) {
      symlinkSync(real, to, "junction");
      return;
    }
    // A workspace package: use the worktree's copy, or skip it when the branch does not have it.
    const workspace = relative(repoReal, real);
    if (existsSync(join(worktreePath, workspace))) {
      workspaces.add(workspace);
      symlinkSync(join(worktreePath, workspace), to, "junction");
    }
  };

  mkdirSync(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      mkdirSync(join(target, entry.name));
      for (const child of readdirSync(from)) {
        linkEntry(join(from, child), join(target, entry.name, child));
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkEntry(from, join(target, entry.name));
    }
  }
  for (const workspace of workspaces) {
    const nested = join(repoReal, workspace, "node_modules");
    const dest = join(worktreePath, workspace, "node_modules");
    if (existsSync(nested) && !existsSync(dest)) {
      symlinkSync(nested, dest, "junction");
    }
  }
}

function unlinkIfLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      unlinkSync(path);
    }
  } catch {
    // Missing: nothing to unlink.
  }
}

/**
 * Undoes linkNodeModules (or the older single junction) so that removing the worktree never
 * recurses into the main checkout's node_modules.
 */
export function unlinkNodeModules(worktreePath: string): void {
  const root = join(worktreePath, "node_modules");
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(root);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const worktreeReal = realpathSync(worktreePath);
  const unlinkEntry = (path: string): void => {
    if (!lstatSync(path).isSymbolicLink()) {
      return;
    }
    try {
      const real = realpathSync(path);
      if (isInside(worktreeReal, real)) {
        unlinkIfLink(join(real, "node_modules"));
      }
    } catch {
      // Dangling link: just drop it.
    }
    unlinkSync(path);
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const child of readdirSync(path)) {
        unlinkEntry(join(path, child));
      }
      if (readdirSync(path).length === 0) {
        rmdirSync(path);
      }
    } else {
      unlinkEntry(path);
    }
  }
  if (readdirSync(root).length === 0) {
    rmdirSync(root);
  }
}

/**
 * `name`, or `name-2`, `name-3`… when it is taken: deleting a run keeps its branch, so
 * running the same ticket again must not reuse (or overwrite) it.
 */
export async function freeBranchName(cwd: string, name: string): Promise<string> {
  let candidate = name;
  for (let suffix = 2; await refExists(cwd, `refs/heads/${candidate}`); suffix++) {
    candidate = `${name}-${suffix}`;
  }
  return candidate;
}

function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

async function isRegisteredWorktree(worktree: Worktree): Promise<boolean> {
  const list = await git(worktree.repoPath, ["worktree", "list", "--porcelain"]);
  return list
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => samePath(line.slice("worktree ".length), worktree.path));
}

/** True when the branch has commits of its own on top of the base it was created from. */
async function hasOwnCommits(worktree: Worktree): Promise<boolean> {
  try {
    return Number(await git(worktree.repoPath, ["rev-list", "--count", `${worktree.baseRef}..refs/heads/${worktree.branch}`])) > 0;
  } catch {
    return true; // Base gone or unknown: keep the branch to be safe.
  }
}

/**
 * Removes the worktree and forgets its trust entry. The branch goes too with `deleteBranch`,
 * or when it has no commits of its own (a run started by mistake): keeping it would only make
 * the next run of the same ticket take a `-2` name.
 *
 * Throws when git cannot remove it (on Windows, a process with a file or its cwd inside), so
 * that the caller keeps the run instead of leaving an orphan worktree that holds the branch.
 * A worktree that git no longer knows about (removed by hand) is not an error.
 */
export async function removeWorktree(worktree: Worktree, deleteBranch = false): Promise<void> {
  if (!existsSync(worktree.repoPath)) {
    forgetWorktree(worktree.path);
    return;
  }
  // Unlink the node_modules junctions first so nothing recurses into the main checkout.
  unlinkNodeModules(worktree.path);
  // A folder deleted by hand leaves a stale registration that `prune` drops.
  await git(worktree.repoPath, ["worktree", "prune"]);
  for (let attempt = 1; existsSync(worktree.path); attempt++) {
    try {
      await git(worktree.repoPath, ["worktree", "remove", "--force", worktree.path]);
      break;
    } catch (error) {
      if (!(await isRegisteredWorktree(worktree))) {
        break;
      }
      if (attempt >= 3) {
        const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message).trim();
        throw new Error(
          `No se pudo borrar el worktree ${worktree.path}: ${detail}. Cierra las terminales, editores o procesos abiertos en él y vuelve a intentarlo.`,
        );
      }
      // A process that was just killed (a terminal, an agent) may still hold its handles.
      await new Promise((done) => setTimeout(done, 500 * attempt));
    }
  }
  forgetWorktree(worktree.path);
  if ((await refExists(worktree.repoPath, `refs/heads/${worktree.branch}`)) && (deleteBranch || !(await hasOwnCommits(worktree)))) {
    await git(worktree.repoPath, ["branch", "-D", worktree.branch]);
  }
}

const ATTRIBUTION_LINE = /^\s*(co-authored-by|claude-session)\s*:|generated with \[?claude code/i;

/**
 * Drops attribution lines (Co-Authored-By, Claude-Session, "Generated with Claude Code")
 * that a model may add to a commit message or PR description: Nexura never signs the
 * user's commits or PRs.
 */
export function stripAttribution(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !ATTRIBUTION_LINE.test(line))
    .join("\n")
    .trimEnd();
}

/** Stages everything and commits. Returns the new SHA, or undefined when there was nothing to commit. */
export async function commitAll(worktree: Worktree, message: string): Promise<string | undefined> {
  message = stripAttribution(message) || "chore: nexura changes";
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
