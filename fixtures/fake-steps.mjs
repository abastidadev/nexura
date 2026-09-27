// What the fake agents (fake-claude, fake-codex, fake-copilot) answer for each Nexura step.
// Each fake only differs in its output format; the step logic and the call counters are
// shared, so a flow that mixes agents behaves like one that does not.
//
// Env:
//   FAKE_STATE_DIR        where call counters (and the fake codex/copilot arguments) are kept (required)
//   FAKE_REVIEW_REJECTS   how many times codeReview answers "changes" before approving
//                         (counts calls: a blind review makes two per round, whatever their agents)
//   FAKE_REVIEW_SPLIT     each rejecting codeReview call flags a different file, so blind judges disagree
//   FAKE_FAIL_MARKER      if the prompt contains it, enrich fails (unless resumed/overridden)
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
      output = { approach: "fake", changes: [], acceptanceCriteria: [{ description: "check", command: "npm run check" }] };
      break;
    case "implement":
      writeFileSync(join(process.cwd(), `impl-${count}.txt`), `implement ${count}\n`);
      writeFileSync(join(process.cwd(), "done.txt"), "ok\n");
      output = {
        summary: `implement ${count}`,
        commitMessage: `feat(fake): implement ${count}`,
        tasksDone: ["t1"],
        filesChanged: [`impl-${count}.txt`],
        notes: prompt.includes("[major]") ? "arreglado feedback" : "",
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

/** Keeps what a fake codex/copilot received, for the tests: `<agent>-<step>-<count>.json`. */
export function recordCall(agent, step, count, args, prompt) {
  writeFileSync(join(stateDir, `${agent}-${step}-${count}.json`), JSON.stringify({ args, prompt, cwd: process.cwd() }, null, 2));
}
