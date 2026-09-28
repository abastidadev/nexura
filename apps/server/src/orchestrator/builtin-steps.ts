import type { NexuraEvent, RepoConfig, Worktree } from "@nexura/shared";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, runShell } from "../workspace/git.ts";
import { autoFixQaFailures, type AutoFixResult } from "./auto-fix.ts";

const OUTPUT_TAIL = 4000;
/** Reject npm routing flags: plan commands select their package through repo/workdir. */
const ALLOWED_PLAN_COMMAND = /^npm run [\w:.-]+(?: --(?: [\w:.=/-]+)*)?$/;

export type EmitFn = (event: NexuraEvent) => void;

export type QaFailure = { repo: string; command: string; exitCode: number | null; outputTail: string };
/** A plan command that could not run (bad repo, workdir or script): the plan's mistake, not the code's. */
export type QaConfigError = { repo: string; command: string; error: string };
/** `passed` only reflects the commands that ran; `configErrors` never sends the work back to implement. */
export type QaOutput = { passed: boolean; commands: number; failures: QaFailure[]; configErrors: QaConfigError[]; autoFixes?: AutoFixResult[] };

type AcceptanceCriterion = { description: string; command?: string; repo?: string | null; workdir?: string | null };

/** Plan paths are relative to a selected worktree, including after resolving symlinks. */
function planDirectory(worktree: Worktree, workdir: string): string {
  const root = realpathSync(worktree.path);
  if (isAbsolute(workdir) || /^[A-Za-z]:/.test(workdir)) {
    throw new Error(`Configuración de QA: workdir debe ser relativo (${workdir}).`);
  }
  const cwd = realpathSync(resolve(root, workdir));
  const distance = relative(root, cwd);
  if (distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance) || !statSync(cwd).isDirectory()) {
    throw new Error(`Configuración de QA: workdir fuera del worktree o no es un directorio (${workdir}).`);
  }
  return cwd;
}

function checkPlanScript(cwd: string, command: string): void {
  const script = command.split(" ")[2]!;
  let manifest: { scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    throw new Error(`Configuración de QA: no se puede leer package.json en ${cwd}. Corrige workdir en el plan; no es un fallo del código.`);
  }
  if (typeof manifest?.scripts?.[script] !== "string") {
    throw new Error(`Configuración de QA: no existe el script ${script} en ${cwd}. Corrige el comando del plan; no es un fallo del código.`);
  }
}

/** Where and how a plan command runs; throws a `Configuración de QA` error when it cannot. */
function planJob(worktrees: Worktree[], criterion: AcceptanceCriterion, command: string): { worktree: Worktree; command: string; cwd: string } {
  if (!ALLOWED_PLAN_COMMAND.test(command)) {
    throw new Error("Configuración de QA: comando del plan no permitido (npm run <script> [-- argumentos]; selecciona el paquete con repo/workdir).");
  }
  const worktree = criterion.repo ? worktrees.find((candidate) => candidate.repo === criterion.repo) : worktrees[0];
  if (!worktree) {
    throw new Error(`Configuración de QA: repositorio del plan desconocido (${criterion.repo ?? "principal"}).`);
  }
  const workdir = criterion.workdir || ".";
  let cwd: string;
  try {
    cwd = planDirectory(worktree, workdir);
  } catch (error) {
    const message = (error as Error).message;
    throw message.startsWith("Configuración de QA") ? error : new Error(`Configuración de QA: no existe el directorio ${workdir} en el worktree.`);
  }
  checkPlanScript(cwd, command);
  return { worktree, command, cwd };
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? "…" + text.slice(-OUTPUT_TAIL) : text;
}

/**
 * qaCode without an LLM: runs the repo's configured checks in every worktree, plus the
 * plan's acceptance commands (only `npm run ...`) in their selected repo/directory. An
 * invalid plan command is reported and skipped, so it never blocks the configured checks.
 */
export async function runQaCode(
  worktrees: Worktree[],
  repos: RepoConfig[],
  planOutput: unknown,
  timeoutMs: number,
  emit: EmitFn,
): Promise<QaOutput> {
  const jobs: { worktree: Worktree; command: string; cwd: string }[] = [];
  for (const worktree of worktrees) {
    const repo = repos.find((candidate) => candidate.name === worktree.repo);
    for (const command of repo?.checks ?? []) {
      jobs.push({ worktree, command, cwd: worktree.path });
    }
  }
  const configErrors: QaConfigError[] = [];
  const criteria = (planOutput as { acceptanceCriteria?: AcceptanceCriterion[] })?.acceptanceCriteria ?? [];
  for (const criterion of criteria) {
    const command = criterion.command?.trim();
    if (!command) {
      continue;
    }
    try {
      const job = planJob(worktrees, criterion, command);
      if (!jobs.some((other) => other.worktree === job.worktree && resolve(other.cwd) === resolve(job.cwd) && other.command === command)) {
        jobs.push(job);
      }
    } catch (error) {
      const configError = { repo: criterion.repo ?? worktrees[0]?.repo ?? "", command, error: (error as Error).message };
      configErrors.push(configError);
      emit({ kind: "text", text: `Se omite (${configError.error}): ${command}` });
    }
  }

  const check = async (): Promise<{ failures: QaFailure[]; failedJobs: (QaFailure & { cwd: string })[] }> => {
    const failures: QaFailure[] = [];
    const failedJobs: (QaFailure & { cwd: string })[] = [];
    for (const [index, job] of jobs.entries()) {
      const id = `qa-${index}`;
      emit({
        kind: "toolUse",
        id,
        name: "Shell",
        input: { command: job.command, repo: job.worktree.repo, cwd: job.cwd },
        parentToolUseId: null,
      });
      const result = await runShell(job.command, job.cwd, timeoutMs);
      const failed = result.exitCode !== 0 || result.timedOut;
      emit({
        kind: "toolResult",
        toolUseId: id,
        content: (result.timedOut ? "[TIMEOUT]\n" : "") + tail(result.output),
        isError: failed,
        parentToolUseId: null,
      });
      if (failed) {
        const failure: QaFailure = {
          repo: job.worktree.repo,
          command: job.command,
          exitCode: result.exitCode,
          outputTail: tail(result.output),
        };
        failures.push(failure);
        failedJobs.push({ ...failure, cwd: job.cwd });
      }
    }
    return { failures, failedJobs };
  };
  if (jobs.length === 0) {
    const reasons = configErrors.map((configError) => `\`${configError.command}\`: ${configError.error}`).join("; ");
    throw new Error(
      reasons
        ? `QA sin verificar: ningún comando del plan es ejecutable y el repositorio no tiene checks configurados (${reasons}).`
        : "QA sin verificar: no hay checks configurados en el repositorio ni comandos en el plan. Configura las comprobaciones antes de continuar.",
    );
  }
  const first = await check();
  let autoFixes: AutoFixResult[] = [];
  if (first.failures.length) {
    try {
      autoFixes = await autoFixQaFailures(first.failedJobs, worktrees, timeoutMs, emit);
    } catch (error) {
      emit({ kind: "text", text: `Autofix omitido: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const failures = autoFixes.length ? (await check()).failures : first.failures;
  return { passed: failures.length === 0, commands: jobs.length, failures, configErrors,
    ...(autoFixes.length ? { autoFixes } : {}) };
}

export type ReleaseBranch = { repo: string; branch: string; sha: string; commits: string[]; diffStat: string };
export type ReleaseOutput = { pushed: boolean; branches: ReleaseBranch[] };

/** Local release (phase 1): records branch, SHA and commits. Push + PR arrive in phase 5. */
export async function runReleaseLocal(worktrees: Worktree[], emit: EmitFn): Promise<ReleaseOutput> {
  const branches: ReleaseBranch[] = [];
  for (const worktree of worktrees) {
    const sha = await git(worktree.path, ["rev-parse", "HEAD"]);
    const log = await git(worktree.path, ["log", "--oneline", `${worktree.baseRef}..HEAD`]);
    const commits = log ? log.split(/\r?\n/) : [];
    const diffStat = commits.length ? await git(worktree.path, ["diff", "--stat", `${worktree.baseRef}...HEAD`]) : "";
    branches.push({ repo: worktree.repo, branch: worktree.branch, sha, commits, diffStat });
    emit({
      kind: "text",
      text: `**${worktree.repo}** · rama \`${worktree.branch}\` · ${commits.length} commit(s)\n\n${diffStat}`,
    });
  }
  if (branches.every((branch) => branch.commits.length === 0)) {
    throw new Error("No hay commits en ninguna rama: implement no dejó cambios");
  }
  return { pushed: false, branches };
}
