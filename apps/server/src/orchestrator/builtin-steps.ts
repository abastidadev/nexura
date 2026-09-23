import type { NexuraEvent, RepoConfig, Worktree } from "@nexura/shared";
import { git, runShell } from "../workspace/git.ts";

const OUTPUT_TAIL = 4000;
/** Only these plan-provided commands are run by qaCode; anything else is ignored. */
const ALLOWED_PLAN_COMMAND = /^npm run [\w:.-]+( [\w:.=/-]+)*$/;

export type EmitFn = (event: NexuraEvent) => void;

export type QaFailure = { repo: string; command: string; exitCode: number | null; outputTail: string };
export type QaOutput = { passed: boolean; commands: number; failures: QaFailure[] };

type AcceptanceCriterion = { description: string; command?: string };

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? "…" + text.slice(-OUTPUT_TAIL) : text;
}

/**
 * qaCode without an LLM: runs the repo's configured checks in every worktree, plus the
 * plan's acceptance commands (only `npm run ...`) in the primary worktree.
 */
export async function runQaCode(
  worktrees: Worktree[],
  repos: RepoConfig[],
  planOutput: unknown,
  timeoutMs: number,
  emit: EmitFn,
): Promise<QaOutput> {
  const jobs: { worktree: Worktree; command: string }[] = [];
  for (const worktree of worktrees) {
    const repo = repos.find((candidate) => candidate.name === worktree.repo);
    for (const command of repo?.checks ?? []) {
      jobs.push({ worktree, command });
    }
  }
  const criteria = ((planOutput as { acceptanceCriteria?: AcceptanceCriterion[] })?.acceptanceCriteria ?? [])
    .map((criterion) => criterion.command?.trim())
    .filter((command): command is string => Boolean(command));
  for (const command of criteria) {
    if (!ALLOWED_PLAN_COMMAND.test(command)) {
      emit({ kind: "text", text: `Ignorado (no es \`npm run ...\`): ${command}` });
    } else if (!jobs.some((job) => job.worktree === worktrees[0] && job.command === command)) {
      jobs.push({ worktree: worktrees[0]!, command });
    }
  }

  const failures: QaFailure[] = [];
  for (const [index, job] of jobs.entries()) {
    const id = `qa-${index}`;
    emit({
      kind: "toolUse",
      id,
      name: "Shell",
      input: { command: job.command, repo: job.worktree.repo },
      parentToolUseId: null,
    });
    const result = await runShell(job.command, job.worktree.path, timeoutMs);
    const failed = result.exitCode !== 0 || result.timedOut;
    emit({
      kind: "toolResult",
      toolUseId: id,
      content: (result.timedOut ? "[TIMEOUT]\n" : "") + tail(result.output),
      isError: failed,
      parentToolUseId: null,
    });
    if (failed) {
      failures.push({
        repo: job.worktree.repo,
        command: job.command,
        exitCode: result.exitCode,
        outputTail: tail(result.output),
      });
    }
  }
  if (jobs.length === 0) {
    emit({ kind: "text", text: "No hay checks configurados en repos.json ni comandos en el plan." });
  }
  return { passed: failures.length === 0, commands: jobs.length, failures };
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
