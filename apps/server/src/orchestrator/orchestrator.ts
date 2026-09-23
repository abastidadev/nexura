import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  STEP_NAMES,
  type FlowProfile,
  type NexuraEvent,
  type QuotaInfo,
  type RetryOptions,
  type Run,
  type RunRequest,
  type ServerMessage,
  type StepConfig,
  type StepName,
  type StepRun,
} from "@nexura/shared";
import type { LoadedStep, NexuraConfig } from "../config/config-loader.ts";
import { Ledger } from "../ledger/ledger.ts";
import { asJsonBlock, renderTemplate } from "../prompt/render.ts";
import { ClaudeProcess } from "../runner/claude-process.ts";
import type { RunStore } from "../store/run-store.ts";
import { commitAll, createWorktree, removeWorktree, slugify } from "../workspace/git.ts";
import { runQaCode, runReleaseLocal, type QaOutput } from "./builtin-steps.ts";

/** Deciding the profile must be cheap. */
const CLASSIFY_CONFIG: StepConfig = { model: "haiku", effort: "low", enabled: true };
const DEFAULT_BRANCH_PREFIX = "feat";
const RATE_LIMIT_MARGIN_MS = 60_000;
const ERROR_TEXT_MAX = 1500;
const RESUME_DEFAULT_INSTRUCTION = "Continúa donde lo dejaste y termina el paso.";

class CancelledError extends Error {}

type RunContext = {
  cancelled: boolean;
  process?: ClaudeProcess;
  /** Resolves a breakpoint pause, optionally with overrides for the next step. */
  release?: (options?: RetryOptions) => void;
  /** Wakes a rate-limit wait early (cancel). */
  wake?: () => void;
};

type StepContext = {
  outputs: Map<StepName, unknown>;
  feedback?: string;
  ledger: Ledger;
};

type StepOutcome = { stepRun: StepRun; rateLimitedUntil?: number };

export type OrchestratorOptions = { concurrency: number };

export class Orchestrator extends EventEmitter<{ message: [ServerMessage] }> {
  private config: NexuraConfig;
  private readonly store: RunStore;
  private readonly options: OrchestratorOptions;
  private readonly contexts = new Map<string, RunContext>();
  private readonly waiting: (() => void)[] = [];
  private readonly eventSeq = new Map<string, number>();
  private running = 0;
  private quota?: QuotaInfo;

  public constructor(config: NexuraConfig, store: RunStore, options: OrchestratorOptions = { concurrency: 2 }) {
    super();
    this.config = config;
    this.store = store;
    this.options = options;
  }

  public setConfig(config: NexuraConfig): void {
    this.config = config;
  }

  public getQuota(): QuotaInfo | undefined {
    return this.quota;
  }

  // ---------------------------------------------------------------- public API

  public start(request: RunRequest): Run {
    if (request.profile !== "auto" && !this.config.profiles.has(request.profile)) {
      throw new Error(`Perfil desconocido: ${request.profile}`);
    }
    if (request.repos.length === 0) {
      throw new Error("Selecciona al menos un repositorio");
    }
    for (const name of request.repos) {
      if (!this.config.repos.some((repo) => repo.name === name)) {
        throw new Error(`Repositorio no configurado en repos.json: ${name}`);
      }
    }
    const run: Run = {
      id: randomUUID().slice(0, 8),
      request,
      status: "queued",
      resolvedProfile: request.profile === "auto" ? undefined : request.profile,
      createdAt: new Date().toISOString(),
      steps: [],
      worktrees: [],
      totalCostUsd: 0,
    };
    this.persist(run);
    this.contexts.set(run.id, { cancelled: false });
    void this.schedule(run.id, () => this.execute(run));
    return run;
  }

  /** Re-runs the flow from its last failed/cancelled step, with optional overrides. */
  public retry(runId: string, options: RetryOptions = {}): Run {
    const run = this.requireRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`El run ${runId} no está fallido ni cancelado (${run.status})`);
    }
    const last = run.steps.at(-1);
    run.status = "queued";
    run.error = undefined;
    this.persist(run);
    this.contexts.set(runId, { cancelled: false });
    void this.schedule(runId, () => this.execute(run, last ? { step: last.step, options } : undefined));
    return run;
  }

  /** Releases a breakpoint; the options (e.g. an edited prompt) apply to the step about to run. */
  public continue(runId: string, options?: RetryOptions): void {
    const context = this.contexts.get(runId);
    if (!context?.release) {
      throw new Error(`El run ${runId} no está pausado`);
    }
    context.release(options);
  }

  public cancel(runId: string): void {
    const context = this.contexts.get(runId);
    if (!context) {
      throw new Error(`El run ${runId} no está activo`);
    }
    context.cancelled = true;
    context.process?.kill();
    context.release?.();
    context.wake?.();
  }

  public async cleanup(runId: string, deleteBranches = false): Promise<void> {
    const run = this.requireRun(runId);
    if (this.contexts.has(runId)) {
      throw new Error("No se puede limpiar un run activo");
    }
    for (const worktree of run.worktrees) {
      await removeWorktree(worktree, deleteBranches);
    }
    run.worktrees = [];
    this.persist(run);
  }

  // ---------------------------------------------------------------- scheduling

  private async schedule(runId: string, job: () => Promise<void>): Promise<void> {
    const context = this.contexts.get(runId);
    if (this.running >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      await job();
    } catch (error) {
      const run = this.store.getRun(runId);
      if (run) {
        this.fail(run, `Error interno: ${String(error)}`);
      }
    } finally {
      this.running--;
      this.releaseContext(runId, context);
      this.waiting.shift()?.();
    }
  }

  private async execute(initial: Run, startAt?: { step: StepName; options: RetryOptions }): Promise<void> {
    const run = this.store.getRun(initial.id) ?? initial;
    const context = this.contexts.get(run.id)!;
    if (context.cancelled) {
      run.status = "cancelled";
      this.releaseContext(run.id, context);
      this.persist(run);
      return;
    }
    run.status = "running";
    this.persist(run);
    const ledger = new Ledger(run.id);

    try {
      if (run.worktrees.length === 0) {
        await this.setupWorktrees(run, ledger);
      }

      // Outputs of earlier successful steps, so a retry does not redo them.
      const stepContext: StepContext = { outputs: new Map(), ledger };
      for (const stepRun of run.steps) {
        if (stepRun.status === "succeeded") {
          stepContext.outputs.set(stepRun.step, stepRun.structuredOutput);
        }
      }
      let pending = startAt?.options;

      if (!run.resolvedProfile) {
        const classified = await this.runWithRateLimit(run, context, "classify", CLASSIFY_CONFIG, stepContext, pending);
        pending = undefined;
        if (!classified) {
          return;
        }
        const output = classified.structuredOutput as { profile: string; reason: string };
        if (!this.config.profiles.has(output.profile)) {
          this.fail(run, `classify eligió un perfil inexistente: ${output.profile}`);
          return;
        }
        run.resolvedProfile = output.profile;
        run.classifyReason = output.reason;
        ledger.append("classify", `Perfil **${output.profile}**: ${output.reason}`);
        this.persist(run);
      }

      const profile = this.config.profiles.get(run.resolvedProfile)!;
      const sequence = STEP_NAMES.filter((name) => name !== "classify" && profile.steps[name]?.enabled);
      let index = startAt && startAt.step !== "classify" ? Math.max(0, sequence.indexOf(startAt.step)) : 0;
      let loops = Math.max(0, run.steps.filter((s) => s.step === "implement" && s.status === "succeeded").length - 1);

      if (pending?.skip) {
        this.recordSkipped(run, sequence[index]!, profile);
        pending = undefined;
        index++;
      }

      while (index < sequence.length) {
        const stepName = sequence[index]!;
        const stepConfig = profile.steps[stepName]!;

        if (run.request.stepByStep) {
          pending = (await this.breakpoint(run, context, stepName, stepContext, pending)) ?? pending;
          if (pending?.skip) {
            this.recordSkipped(run, stepName, profile);
            pending = undefined;
            index++;
            continue;
          }
        }

        const stepRun = await this.runWithRateLimit(run, context, stepName, stepConfig, stepContext, pending);
        pending = undefined;
        if (!stepRun) {
          return;
        }
        stepContext.outputs.set(stepName, stepRun.structuredOutput);

        if (stepName === "implement") {
          await this.afterImplement(run, stepRun, ledger);
          stepContext.feedback = undefined;
        }

        const rework = this.reworkNeeded(stepName, stepRun.structuredOutput);
        if (rework) {
          const implementIndex = sequence.indexOf("implement");
          if (implementIndex < 0) {
            this.fail(run, `${stepName} pide cambios pero el perfil no tiene paso implement`);
            return;
          }
          if (loops >= profile.maxLoops) {
            this.fail(run, `${stepName} sigue pidiendo cambios tras ${loops} vuelta(s) (maxLoops=${profile.maxLoops})`);
            return;
          }
          loops++;
          stepContext.feedback = rework;
          ledger.append(stepName, `Devuelve el trabajo a implement (vuelta ${loops}):\n${rework}`);
          index = implementIndex;
          continue;
        }
        index++;
      }

      run.status = "done";
      run.pendingStep = undefined;
      this.releaseContext(run.id, context);
      this.persist(run);
    } catch (error) {
      if (error instanceof CancelledError || context.cancelled) {
        run.status = "cancelled";
        run.pendingStep = undefined;
        run.resumesAt = undefined;
        this.releaseContext(run.id, context);
        this.persist(run);
      } else {
        this.fail(run, String(error instanceof Error ? error.message : error));
      }
    }
  }

  // ---------------------------------------------------------------- steps

  /** Runs a step; when the usage limit hits, waits for the window to reset and tries again. */
  private async runWithRateLimit(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepConfig: StepConfig,
    stepContext: StepContext,
    options?: RetryOptions,
  ): Promise<StepRun | undefined> {
    for (;;) {
      const { stepRun, rateLimitedUntil } = await this.runStep(run, context, stepName, stepConfig, stepContext, options);
      if (context.cancelled) {
        throw new CancelledError();
      }
      if (stepRun.status === "succeeded") {
        return stepRun;
      }
      if (rateLimitedUntil === undefined) {
        this.fail(run, `Falló el paso ${stepName}: ${stepRun.error ?? "error desconocido"}`);
        return undefined;
      }
      run.status = "waiting-rate-limit";
      run.resumesAt = rateLimitedUntil;
      this.persist(run);
      await this.sleepUntil(context, rateLimitedUntil * 1000 + RATE_LIMIT_MARGIN_MS);
      if (context.cancelled) {
        throw new CancelledError();
      }
      run.status = "running";
      run.resumesAt = undefined;
      this.persist(run);
    }
  }

  private async runStep(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepConfig: StepConfig,
    stepContext: StepContext,
    options?: RetryOptions,
  ): Promise<StepOutcome> {
    const definition = this.config.steps.get(stepName);
    const stepRun: StepRun = {
      id: randomUUID(),
      runId: run.id,
      step: stepName,
      attempt: run.steps.filter((s) => s.step === stepName).length + 1,
      seq: run.steps.length,
      status: "running",
      kind: definition?.kind ?? "claude",
      model: options?.model ?? stepConfig.model,
      effort: options?.effort ?? stepConfig.effort,
      startedAt: new Date().toISOString(),
      costUsd: 0,
      numTurns: 0,
    };
    run.steps.push(stepRun);
    this.store.saveStepRun(stepRun);
    this.persist(run);

    let rateLimitedUntil: number | undefined;
    try {
      if (!definition) {
        throw new Error(`No hay definición para el paso ${stepName} en config/steps`);
      }
      if (definition.kind === "builtin") {
        stepRun.structuredOutput = await this.runBuiltin(run, stepRun, stepContext, definition);
        stepRun.status = "succeeded";
      } else {
        rateLimitedUntil = await this.runClaude(run, context, stepRun, stepContext, definition, options);
      }
    } catch (error) {
      stepRun.status = "failed";
      stepRun.error = error instanceof Error ? error.message : String(error);
    }
    if (context.cancelled && stepRun.status === "running") {
      stepRun.status = "failed";
      stepRun.error = "Cancelado";
    }
    stepRun.finishedAt = new Date().toISOString();
    this.store.saveStepRun(stepRun);
    run.totalCostUsd = run.steps.reduce((sum, s) => sum + s.costUsd, 0);
    this.persist(run);
    return { stepRun, rateLimitedUntil };
  }

  /** Returns the reset time (epoch s) when the step failed because of the usage limit. */
  private async runClaude(
    run: Run,
    context: RunContext,
    stepRun: StepRun,
    stepContext: StepContext,
    definition: LoadedStep,
    options?: RetryOptions,
  ): Promise<number | undefined> {
    let prompt: string;
    let resume: string | undefined;
    const previous = options?.resumeSession
      ? run.steps.findLast((s) => s.step === stepRun.step && s.id !== stepRun.id && s.sessionId)
      : undefined;
    if (previous?.sessionId) {
      resume = previous.sessionId;
      prompt = options?.instruction?.trim() || RESUME_DEFAULT_INSTRUCTION;
    } else {
      prompt = options?.prompt ?? this.renderPrompt(run, stepRun.step, stepContext);
    }

    const [primary, ...others] = run.worktrees;
    const process = new ClaudeProcess({
      cwd: primary!.path,
      prompt,
      model: stepRun.model,
      effort: stepRun.effort,
      tools: definition.tools,
      allowedTools: definition.allowedTools,
      disallowedTools: definition.disallowedTools,
      useMcp: definition.useMcp,
      addDirs: others.map((worktree) => worktree.path),
      jsonSchema: definition.schema,
      timeoutMs: definition.timeoutMs,
      resume,
      forkSession: Boolean(resume),
    });
    stepRun.prompt = prompt;
    stepRun.args = process.args;
    this.store.saveStepRun(stepRun);
    this.persist(run);

    let rejectedUntil: number | undefined;
    process.on("raw", (line) => this.store.appendRaw(run.id, stepRun, line));
    process.on("event", (event) => {
      this.recordEvent(run, stepRun, event);
      if (event.kind === "init") {
        stepRun.sessionId = event.sessionId;
        this.store.saveStepRun(stepRun);
      }
      if (event.kind === "rateLimit") {
        this.updateQuota(event);
        if (event.status === "rejected") {
          rejectedUntil = event.resetsAt;
        }
      }
    });

    context.process = process;
    const outcome = await process.run();
    context.process = undefined;

    const result = outcome.result;
    stepRun.sessionId = outcome.sessionId ?? stepRun.sessionId;
    if (result) {
      stepRun.costUsd = result.costUsd;
      stepRun.numTurns = result.numTurns;
      stepRun.usage = result.usage;
      stepRun.structuredOutput = result.structuredOutput;
    }

    let error: string | undefined;
    if (context.cancelled) {
      error = "Cancelado";
    } else if (outcome.timedOut) {
      error = `Timeout tras ${Math.round(definition.timeoutMs / 1000)} s`;
    } else if (!result) {
      error = `claude terminó (exit ${outcome.exitCode}) sin evento result. ${outcome.stderr.slice(-ERROR_TEXT_MAX)}`;
    } else if (!result.success) {
      const status = result.apiErrorStatus ? ` (HTTP ${result.apiErrorStatus})` : "";
      error = `${result.subtype}${status}: ${result.text.slice(0, ERROR_TEXT_MAX)}`;
    } else if (definition.schema && result.structuredOutput === undefined) {
      error = "El paso no devolvió la salida estructurada que exige su schema";
    }

    if (error) {
      stepRun.status = "failed";
      stepRun.error = error;
      const limited = rejectedUntil !== undefined || result?.apiErrorStatus === 429;
      return limited ? (rejectedUntil ?? this.quota?.fiveHour?.resetsAt ?? Date.now() / 1000 + 300) : undefined;
    }
    stepRun.status = "succeeded";
    return undefined;
  }

  private async runBuiltin(
    run: Run,
    stepRun: StepRun,
    stepContext: StepContext,
    definition: LoadedStep,
  ): Promise<unknown> {
    const emit = (event: NexuraEvent): void => this.recordEvent(run, stepRun, event);
    switch (stepRun.step) {
      case "qaCode": {
        const output = await runQaCode(
          run.worktrees,
          this.config.repos,
          stepContext.outputs.get("plan"),
          definition.timeoutMs,
          emit,
        );
        stepContext.ledger.append(
          "qaCode",
          output.passed
            ? `${output.commands} comando(s) OK`
            : `Fallan: ${output.failures.map((f) => `\`${f.command}\` (${f.repo})`).join(", ")}`,
        );
        return output;
      }
      case "release": {
        const output = await runReleaseLocal(run.worktrees, emit);
        stepContext.ledger.append(
          "release",
          output.branches.map((b) => `${b.repo}: rama \`${b.branch}\` @ ${b.sha.slice(0, 8)}`).join("\n"),
        );
        return output;
      }
      default:
        throw new Error(`El paso ${stepRun.step} no tiene implementación builtin`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private async setupWorktrees(run: Run, ledger: Ledger): Promise<void> {
    const firstLine = run.request.ticketText.split(/\r?\n/)[0] ?? "";
    for (const name of run.request.repos) {
      const repo = this.config.repos.find((candidate) => candidate.name === name)!;
      const branch = `${repo.branchPrefix ?? DEFAULT_BRANCH_PREFIX}/${run.request.ticketId ?? run.id}-${slugify(firstLine)}`;
      run.worktrees.push(await createWorktree(repo, run.id, branch));
      this.persist(run);
    }
    ledger.append(
      "setup",
      run.worktrees.map((w) => `${w.repo}: worktree \`${w.path}\`, rama \`${w.branch}\` desde \`${w.baseRef}\``).join("\n"),
    );
  }

  private async afterImplement(run: Run, stepRun: StepRun, ledger: Ledger): Promise<void> {
    const output = stepRun.structuredOutput as {
      summary: string;
      commitMessage: string;
      tasksDone: string[];
      filesChanged: string[];
      notes: string;
    };
    const shas: string[] = [];
    for (const worktree of run.worktrees) {
      const sha = await commitAll(worktree, output.commitMessage);
      if (sha) {
        shas.push(`${worktree.repo}@${sha.slice(0, 8)}`);
        this.recordEvent(run, stepRun, { kind: "text", text: `Commit \`${sha.slice(0, 8)}\` en ${worktree.repo}` });
      }
    }
    for (const task of run.request.tasks) {
      if (output.tasksDone.includes(task.id)) {
        task.done = true;
      }
    }
    ledger.append(
      `implement (intento ${stepRun.attempt})`,
      [
        output.summary,
        `Ficheros: ${output.filesChanged.join(", ") || "ninguno"}`,
        `Commits: ${shas.join(", ") || "sin cambios"}`,
        output.notes ? `Notas: ${output.notes}` : "",
      ].join("\n"),
    );
    this.persist(run);
  }

  private reworkNeeded(stepName: StepName, output: unknown): string | undefined {
    if (stepName === "codeReview") {
      const review = output as { verdict: string; issues: { severity: string; file: string; problem: string; fix: string }[] };
      if (review.verdict !== "changes") {
        return undefined;
      }
      return review.issues
        .filter((issue) => issue.severity !== "minor")
        .map((issue) => `- [${issue.severity}] ${issue.file}: ${issue.problem} → ${issue.fix}`)
        .join("\n");
    }
    if (stepName === "qaCode") {
      const qa = output as QaOutput;
      if (qa.passed) {
        return undefined;
      }
      return qa.failures
        .map((f) => `- \`${f.command}\` en ${f.repo} (exit ${f.exitCode}):\n\`\`\`\n${f.outputTail.slice(-1500)}\n\`\`\``)
        .join("\n");
    }
    return undefined;
  }

  private renderPrompt(run: Run, stepName: StepName, stepContext: StepContext): string {
    const template = this.config.steps.get(stepName)?.promptTemplate ?? "";
    const request = run.request;
    const vars: Record<string, string | undefined> = {
      ticket: (request.ticketId ? `#${request.ticketId}\n\n` : "") + request.ticketText,
      tasks: request.tasks
        .filter((task) => task.selected)
        .map((task) => `- [${task.done ? "x" : " "}] (${task.id}) ${task.title}`)
        .join("\n"),
      repos: run.worktrees
        .map((w) => `- **${w.repo}**: \`${w.path}\` (rama \`${w.branch}\`, baseRef \`${w.baseRef}\`)`)
        .join("\n"),
      userPrompt: request.prompt,
      ledger: stepContext.ledger.read(),
      feedback: stepContext.feedback,
    };
    for (const [name, output] of stepContext.outputs) {
      vars[`output.${name}`] = asJsonBlock(output);
    }
    return renderTemplate(template, vars);
  }

  private async breakpoint(
    run: Run,
    context: RunContext,
    stepName: StepName,
    stepContext: StepContext,
    pending?: RetryOptions,
  ): Promise<RetryOptions | undefined> {
    const kind = this.config.steps.get(stepName)?.kind;
    run.status = "paused";
    run.pendingStep = {
      step: stepName,
      prompt: kind === "claude" ? (pending?.prompt ?? this.renderPrompt(run, stepName, stepContext)) : undefined,
    };
    this.persist(run);
    const options = await new Promise<RetryOptions | undefined>((resolve) => (context.release = resolve));
    context.release = undefined;
    if (context.cancelled) {
      throw new CancelledError();
    }
    run.status = "running";
    run.pendingStep = undefined;
    this.persist(run);
    return options;
  }

  private recordSkipped(run: Run, stepName: StepName, profile: FlowProfile): void {
    const config = profile.steps[stepName];
    const stepRun: StepRun = {
      id: randomUUID(),
      runId: run.id,
      step: stepName,
      attempt: run.steps.filter((s) => s.step === stepName).length + 1,
      seq: run.steps.length,
      status: "skipped",
      kind: this.config.steps.get(stepName)?.kind ?? "claude",
      model: config?.model ?? "haiku",
      effort: config?.effort ?? "low",
      costUsd: 0,
      numTurns: 0,
    };
    run.steps.push(stepRun);
    this.store.saveStepRun(stepRun);
    this.persist(run);
  }

  private sleepUntil(context: RunContext, epochMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, epochMs - Date.now()));
      context.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private recordEvent(run: Run, stepRun: StepRun, event: NexuraEvent): void {
    const seq = this.eventSeq.get(stepRun.id) ?? 0;
    this.eventSeq.set(stepRun.id, seq + 1);
    this.store.addEvent(run.id, stepRun, seq, event);
    this.emit("message", { type: "event", runId: run.id, stepRunId: stepRun.id, seq, event });
  }

  private updateQuota(event: Extract<NexuraEvent, { kind: "rateLimit" }>): void {
    this.quota = {
      status: event.status,
      fiveHour: event.fiveHour,
      sevenDay: event.sevenDay,
      updatedAt: new Date().toISOString(),
    };
    this.emit("message", { type: "quota", quota: this.quota });
  }

  private fail(run: Run, error: string): void {
    run.status = "failed";
    run.error = error;
    run.pendingStep = undefined;
    run.resumesAt = undefined;
    this.releaseContext(run.id, this.contexts.get(run.id));
    this.persist(run);
  }

  /** Forgets the run context, unless a retry already replaced it with a new one. */
  private releaseContext(runId: string, context: RunContext | undefined): void {
    if (context && this.contexts.get(runId) === context) {
      this.contexts.delete(runId);
    }
  }

  private persist(run: Run): void {
    this.store.saveRun(run);
    this.emit("message", { type: "run", run: structuredClone(run) });
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run no encontrado: ${runId}`);
    }
    return run;
  }
}
