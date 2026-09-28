// What the fake agents (fake-claude, fake-codex, fake-copilot) answer for each Nexura step.
// Each fake only differs in its output format; the step logic and the call counters are
// shared, so a flow that mixes agents behaves like one that does not.
//
// Env:
//   FAKE_STATE_DIR        where call counters (and the fake codex/copilot arguments) are kept (required)
//   FAKE_REVIEW_REJECTS   how many times codeReview answers "changes" before approving
//                         (counts calls: a blind review makes two per round, whatever their agents)
//   FAKE_REVIEW_SPLIT     each rejecting codeReview call flags a different file, so blind judges disagree
//   FAKE_FAIL_MARKER      if the prompt contains it, enrich or plan (the investigating phase) fails (unless resumed/overridden)
//   FAKE_DELAY_MS         pause between events, to watch a flow live in the UI (default 0)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const stateDir = process.env.FAKE_STATE_DIR;

const delayMs = Number(process.env.FAKE_DELAY_MS ?? 0);
export const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));

/** Counts the calls of a step (1 on the first). */
export function bump(step) {
  const file = join(stateDir, `${step}.count`);
  const count = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
  writeFileSync(file, String(count));
  return count;
}

/** The step a prompt belongs to: every template starts with "Eres el paso **<step>**"; classify with "Clasifica". */
export function detectStep(prompt, resumed) {
  // Automatic corrections keep a typed step prompt even when continuing a session.
  const named = /paso \*\*(\w+)\*\*/.exec(prompt)?.[1];
  if (named) {
    return named;
  }
  if (resumed) {
    return "resumed";
  }
  if (/^Clasifica/m.test(prompt)) {
    return "classify";
  }
  return /paso \*\*(\w+)\*\*/.exec(prompt)?.[1] ?? "unknown";
}

/**
 * The step's answer: `{ output, error, text }`. `output` is the structured answer (steps with
 * a schema); custom steps without one edit a file and answer with plain `text`.
 */
export function stepAnswer({ step, count, prompt, hasSchema }) {
  let output;
  let error;
  let text = "ok";
  switch (step) {
    case "classify":
      output = { profile: "minimal", reason: "fake: cambio pequeño" };
      break;
    case "enrich":
      if (process.env.FAKE_FAIL_MARKER && prompt.includes(process.env.FAKE_FAIL_MARKER)) {
        error = "fake enrich failure";
      }
      output = { summary: "fake", relevantFiles: [], conventions: ["Usa inject() en vez de constructores"], risks: [], openQuestions: [] };
      break;
    case "plan":
      if (process.env.FAKE_FAIL_MARKER && prompt.includes(process.env.FAKE_FAIL_MARKER)) {
        error = "fake plan failure";
      }
      output = {
        approach: "fake",
        changes: [],
        acceptanceCriteria: [{ description: "check", command: "npm run check", repo: /- \*\*([^*]+)\*\*:/.exec(prompt)?.[1] ?? "sandbox", workdir: "." }],
        conventions: ["Usa inject() en vez de constructores"],
      };
      break;
    case "implement":
      writeFileSync(join(process.cwd(), `impl-${count}.txt`), `implement ${count}\n`);
      if (!(process.env.FAKE_QA_FAIL_ONCE === "1" && count === 1)) {
        writeFileSync(join(process.cwd(), "done.txt"), "ok\n");
      }
      output = {
        summary: `implement ${count}`,
        commitMessage: `feat(fake): implement ${count}`,
        tasksDone: ["t1"],
        filesChanged: [`impl-${count}.txt`],
        notes: prompt.includes("[major]") ? "arreglado feedback" : "",
        prDescriptions: [{ repo: "sandbox", description: `Implement change ${count}. Verified with npm run check.` }],
      };
      break;
    case "codeReview": {
      const rejects = Number(process.env.FAKE_REVIEW_REJECTS ?? 0);
      output =
        count <= rejects
          ? { verdict: "changes", summary: "fake", issues: [{ severity: "major", file: process.env.FAKE_REVIEW_SPLIT ? `x-${count}` : "x", problem: "p", fix: "f" }] }
          : { verdict: "approve", summary: "fake", issues: [] };
      break;
    }
    case "addressReview": {
      // Answers every "repo `x` · thread N" line of the prompt; fixes the first one in code.
      const threads = [...prompt.matchAll(/repo `([^`]+)` · thread (\d+)/g)].map((match) => ({ repo: match[1], threadId: Number(match[2]) }));
      writeFileSync(join(process.cwd(), `review-${count}.txt`), "fixed\n");
      output = {
        summary: `atendidos ${threads.length} hilos`,
        commitMessage: "fix(fake): address review",
        replies: [
          ...threads.map((thread, index) => ({ ...thread, reply: `respuesta ${thread.threadId}`, action: index === 0 ? "fixed" : "answered" })),
          { repo: "sandbox", threadId: 999, reply: "inventado", action: "fixed" },
        ],
      };
      break;
    }
    case "prReview": {
      // Comments on the first changed file of the prompt's `--name-status` list, one on the PR
      // itself and one on a file that does not exist (the orchestrator must drop it).
      const changed = [...prompt.matchAll(/^[ACMRT]\d*\t(?:[^\t\n]+\t)?([^\t\n]+)$/gm)].map((match) => match[1]);
      const file = changed[0] ?? "README.md";
      output = {
        verdict: "waitingForAuthor",
        summary: `fake: revisados ${changed.length} fichero(s)`,
        conventions: ["Los módulos exportan funciones con nombre"],
        strengths: ["Cambio pequeño y enfocado"],
        comments: [
          {
            severity: "nit",
            file,
            startLine: 1,
            endLine: 1,
            title: "Nombre poco claro",
            post: "Rename to greetUser",
            why: "El resto del repo nombra las funciones con verbo + objeto.",
            suggestion: "",
          },
          {
            severity: "major",
            file,
            startLine: 1,
            endLine: 2,
            title: "Falta validar la entrada",
            post: "Should we validate the input here — before using it?",
            why: "Si llega vacío, la función devuelve un saludo sin nombre y nadie se entera.",
            suggestion: 'if (!name) throw new Error("name required");',
          },
          {
            severity: "minor",
            file: "",
            startLine: 0,
            endLine: 0,
            title: "La PR no tiene descripción",
            post: "Could you add a short description to the PR?",
            why: "Sin descripción cuesta saber qué pretende el cambio.",
            suggestion: "",
          },
          { severity: "blocker", file: "nope/ghost.ts", startLine: 3, endLine: 3, title: "Inventado", post: "ghost", why: "no existe", suggestion: "" },
        ],
      };
      break;
    }
    case "qaNotes":
      output = {
        summary: "fake",
        cases: [{ title: "Caso feliz", steps: ["Abrir la pantalla", "Pulsar el botón"], expected: "Se ve el cambio" }],
        risks: ["Estilos globales"],
      };
      break;
    case "resumed":
      output = { summary: "fake", relevantFiles: [], conventions: [], risks: [], openQuestions: [] };
      break;
    case "ticketDraft":
      output = ticketDraftAnswer(prompt);
      break;
    default:
      if (hasSchema) {
        error = `fake: unknown step for prompt: ${prompt.slice(0, 80)}`;
      } else {
        // A custom step (no schema): edits a file and answers with plain text.
        writeFileSync(join(process.cwd(), `${step}.txt`), `custom ${step}\n`);
        text = `hecho ${step}`;
      }
  }
  return { output, error, text };
}

/**
 * The Tickets assistant: the first turn asks two questions over a half-written bug, an answer
 * completes it, and «Dividir en frontend y backend» returns the two linked items.
 */
function ticketDraftAnswer(prompt) {
  const board = { areaPath: "", sprint: "current" };
  const bug = (side, reproSteps) => ({ side, kind: "bug", title: `Orders / History – ${side === "frontend" ? "Empty status column" : "BFF - Orders. Status missing"}`, description: "", acceptanceCriteria: "", reproSteps, tags: [side === "frontend" ? "Frontend" : "Backend"] });
  if (prompt.includes("Dividir en frontend y backend")) {
    return {
      message: "He separado el trabajo en dos: la pantalla (frontend) y los datos (backend).",
      questions: [],
      items: [
        bug("frontend", "**Error description:**\n\nThe status column is empty.\n\n**Steps to reproduce the error:**\n\n1. Log in with the user demo.\n2. Open Orders / History.\n\n**Expected behavior:**\n\n- The status is shown."),
        bug("backend", "**Error description:**\n\nThe orders endpoint returns no status.\n\n**Steps to reproduce the error:**\n\n1. Log in with the user demo.\n2. Inspect the orders request.\n\n**Expected behavior:**\n\n- Every order has its status."),
      ],
      board,
      suggestSplit: false,
      missing: [],
      ready: true,
    };
  }
  if (prompt.includes("## Lo que dice la persona")) {
    return {
      message: "Listo: con eso el bug queda completo. Revísalo y créalo cuando quieras.",
      questions: [],
      items: [bug("frontend", "**Error description:**\n\nWhen logging in with the user demo and opening Orders / History, the status column is empty.\n\n**Steps to reproduce the error:**\n\n1. Log in with the user demo.\n2. Navigate to Orders / History.\n3. Look at the Status column.\n\n**Expected behavior:**\n\n- Every order shows its status.\n  - Also the cancelled ones.\n- An empty column is never rendered.")],
      board,
      suggestSplit: true,
      missing: [],
      ready: true,
    };
  }
  return {
    message: "Entiendo que en el historial de pedidos no se ve el estado. He mirado la pantalla Pedidos / Historial.",
    questions: [
      { text: "¿Con qué usuario lo has visto?", options: ["demo", "admin", "Con todos"] },
      { text: "¿Pasa con todos los pedidos?", options: ["Sí, con todos", "Solo con algunos"] },
    ],
    items: [bug("frontend", "**Error description:**\n\nThe status column of Orders / History is empty.")],
    board,
    suggestSplit: false,
    missing: ["La cuenta con la que se reproduce"],
    ready: false,
  };
}

/** Keeps what a fake codex/copilot received, for the tests: `<agent>-<step>-<count>.json`. */
export function recordCall(agent, step, count, args, prompt) {
  writeFileSync(join(stateDir, `${agent}-${step}-${count}.json`), JSON.stringify({ args, prompt, cwd: process.cwd() }, null, 2));
}
