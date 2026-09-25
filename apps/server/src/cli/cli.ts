#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { AgentKind, Run, RunRequest, StepName, StepRun } from "@nexura/shared";
import { createApiServer } from "../api/api-server.ts";
import { PrWatcher } from "../forge/pr-watcher.ts";
import { loadConfig } from "../config/config-loader.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { RunStore } from "../store/run-store.ts";
import { formatEvent, formatRunLine } from "./format.ts";

const DEFAULT_PORT = 4310;
const DEFAULT_CONCURRENCY = 2;
const FINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

const USAGE = `Nexura by abastidadev

  nexura serve   [--port ${DEFAULT_PORT}] [--concurrency ${DEFAULT_CONCURRENCY}]
  nexura run     --repo <name> [--repo ...] (--ticket <text> | --ticket-file <file>)
                 [--ticket-id <id>] [--task <title> ...] [--prompt <text>] [--profile auto|minimal|standard|full|copilot-test]
  nexura retry   <runId> [--resume] [--instruction <text>] [--agent claude|codex|copilot] [--model <modelo>] [--skip]
  nexura runs
  nexura show    <runId>
  nexura cleanup <runId> [--delete-branches]
`;

function createOrchestrator(concurrency = DEFAULT_CONCURRENCY): { orchestrator: Orchestrator; store: RunStore } {
  const store = new RunStore();
  store.failInterrupted();
  return { orchestrator: new Orchestrator(loadConfig(), store, { concurrency }), store };
}

/** Prints the progress of one run until it reaches a final status. */
function follow(orchestrator: Orchestrator, runId: string): Promise<Run> {
  let lastStep = "";
  let lastStatus = "";
  return new Promise((resolve) => {
    orchestrator.on("message", (message) => {
      if (message.type === "event" && message.runId === runId) {
        const line = formatEvent(message.event);
        if (line) {
          console.log(line);
        }
      }
      if (message.type !== "run" || message.run.id !== runId) {
        return;
      }
      const run = message.run;
      const current = run.steps.at(-1);
      const stepKey = current ? `${current.id}:${current.status}` : "";
      if (current && stepKey !== lastStep) {
        lastStep = stepKey;
        const cost = current.costUsd ? ` · $${current.costUsd.toFixed(4)}` : "";
        const icon = { running: "▶", succeeded: "✔", failed: "✖", skipped: "⤼", pending: "·" }[current.status];
        console.log(
          `${icon} [${current.step} #${current.attempt}] ${current.status} (${agentLabel(current)}${current.model}/${current.effort})${cost}${current.error ? `\n  ⚠ ${current.error}` : ""}`,
        );
      }
      if (run.status !== lastStatus) {
        lastStatus = run.status;
        console.log(`── run ${run.id}: ${run.status}${run.error ? ` — ${run.error}` : ""}`);
      }
      if (FINAL_STATUSES.has(run.status)) {
        resolve(run);
      }
    });
  });
}

/** "codex · " before the model of Codex/Copilot steps; nothing for Claude (as before). */
function agentLabel(step: StepRun): string {
  return step.agent && step.agent !== "claude" ? `${step.agent} · ` : "";
}

function printSummary(run: Run): void {
  console.log(`\nPerfil: ${run.resolvedProfile ?? "-"}${run.classifyReason ? ` (${run.classifyReason})` : ""}`);
  for (const step of run.steps) {
    console.log(
      `  ${step.step.padEnd(12)} #${step.attempt} ${step.status.padEnd(9)} ${agentLabel(step)}${step.model}/${step.effort}  $${step.costUsd.toFixed(4)}  ${step.numTurns} turnos`,
    );
  }
  console.log(`  Total: $${run.totalCostUsd.toFixed(4)}`);
  for (const worktree of run.worktrees) {
    console.log(`  ${worktree.repo}: ${worktree.path} (${worktree.branch})`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      concurrency: { type: "string" },
      repo: { type: "string", multiple: true },
      ticket: { type: "string" },
      "ticket-file": { type: "string" },
      "ticket-id": { type: "string" },
      task: { type: "string", multiple: true },
      prompt: { type: "string" },
      profile: { type: "string" },
      resume: { type: "boolean" },
      instruction: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      skip: { type: "boolean" },
      "delete-branches": { type: "boolean" },
    },
  });

  switch (command) {
    case "serve": {
      const { orchestrator, store } = createOrchestrator(Number(values.concurrency ?? DEFAULT_CONCURRENCY));
      const port = Number(values.port ?? DEFAULT_PORT);
      new PrWatcher(orchestrator).start();
      const server = createApiServer(orchestrator, store);
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.error(
          error.code === "EADDRINUSE"
            ? `El puerto ${port} ya está en uso: probablemente Nexura ya está arrancado (http://localhost:${port}). Usa --port para otro.`
            : `No se pudo arrancar el servidor: ${error.message}`,
        );
        process.exit(1);
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(`Nexura by abastidadev · http://localhost:${port}`);
      });
      return;
    }
    case "run": {
      const ticketText = values["ticket-file"] ? readFileSync(values["ticket-file"], "utf8") : values.ticket;
      if (!ticketText || !values.repo?.length) {
        console.error(USAGE);
        process.exitCode = 2;
        return;
      }
      const request: RunRequest = {
        ticketId: values["ticket-id"],
        ticketText,
        repos: values.repo,
        tasks: (values.task ?? []).map((title, index) => ({ id: `t${index + 1}`, title, selected: true, done: false })),
        prompt: values.prompt ?? "",
        profile: values.profile ?? "auto",
        stepByStep: false,
      };
      const { orchestrator, store } = createOrchestrator(1);
      const run = orchestrator.start(request);
      console.log(`Run ${run.id} iniciado`);
      const final = await follow(orchestrator, run.id);
      printSummary(store.getRun(final.id)!);
      process.exitCode = final.status === "done" ? 0 : 1;
      return;
    }
    case "retry": {
      const runId = positionals[0];
      if (!runId) {
        console.error(USAGE);
        process.exitCode = 2;
        return;
      }
      const { orchestrator, store } = createOrchestrator(1);
      orchestrator.retry(runId, {
        resumeSession: values.resume,
        instruction: values.instruction,
        agent: values.agent as AgentKind | undefined,
        model: values.model,
        skip: values.skip,
      });
      const final = await follow(orchestrator, runId);
      printSummary(store.getRun(final.id)!);
      process.exitCode = final.status === "done" ? 0 : 1;
      return;
    }
    case "runs": {
      const store = new RunStore();
      store.listRuns(30).forEach((run) => console.log(formatRunLine(run)));
      return;
    }
    case "show": {
      const store = new RunStore();
      const run = positionals[0] ? store.getRun(positionals[0]) : undefined;
      if (!run) {
        console.error("Run no encontrado");
        process.exitCode = 1;
        return;
      }
      console.log(formatRunLine(run));
      if (run.error) {
        console.log(`Error: ${run.error}`);
      }
      printSummary(run);
      const failed = run.steps.findLast((step) => step.status === "failed");
      if (failed) {
        console.log(`\nÚltimo paso fallido: ${failed.step as StepName} #${failed.attempt} — ${failed.error}`);
        console.log(`Sesión: ${failed.sessionId ?? "-"}  (nexura retry ${run.id} --resume)`);
      }
      return;
    }
    case "cleanup": {
      const { orchestrator } = createOrchestrator();
      await orchestrator.cleanup(positionals[0] ?? "", values["delete-branches"]);
      console.log("Worktrees eliminados");
      return;
    }
    default:
      console.log(USAGE);
  }
}

await main();
