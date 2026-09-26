import { CONVERSATION_MODE_FLAGS, type AgentKind, type ConversationMode } from "@nexura/shared";

export type InteractiveOptions = {
  agent: AgentKind;
  /** "" = the CLI's default. */
  model: string;
  /** "" = the CLI's default. */
  effort: string;
  mode: ConversationMode;
  /** Id for a new session (claude and copilot let the caller choose it; codex does not). */
  sessionId?: string;
  /** Session to reopen. */
  resume?: string;
  /** First message, submitted as soon as the CLI starts. */
  prompt?: string;
  /** Extra readable folders (the handoff file lives outside the project). */
  addDirs?: string[];
  /** Display name of a new claude session (its /resume picker and terminal title). */
  name?: string;
};

/** Model ids and effort levels go to the CLI as arguments: nothing that could read as a flag. */
const SAFE_VALUE = /^[A-Za-z0-9][\w.:/[\]-]*$/;

export function checkValue(value: string, what: string): void {
  if (value && !SAFE_VALUE.test(value)) {
    throw new Error(`${what} no válido: ${value}`);
  }
}

/** A value starting with "-" would be parsed as a flag: a leading space keeps it a value. */
function asValue(text: string): string {
  return text.startsWith("-") ? ` ${text}` : text;
}

/**
 * Arguments of the interactive CLI (its TUI, not `-p`/`exec`) for one launch of a conversation.
 *  - claude:  `claude [prompt] --model --effort <mode> --session-id|--resume --add-dir --name`
 *             (the prompt goes first: `--add-dir` is variadic and would swallow it).
 *  - codex:   `codex [resume <id>] -m -c model_reasoning_effort <mode> --no-alt-screen [prompt]`
 *             (inline mode keeps the terminal scrollback).
 *  - copilot: `copilot --model --reasoning-effort <mode> --session-id|--resume --add-dir [-i prompt]`
 */
export function interactiveArgs(options: InteractiveOptions): string[] {
  checkValue(options.model, "Modelo");
  checkValue(options.effort, "Esfuerzo");
  const modeFlags = [...CONVERSATION_MODE_FLAGS[options.agent][options.mode]];
  const addDirs = (options.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]);
  switch (options.agent) {
    case "claude": {
      const args = options.prompt ? [asValue(options.prompt)] : [];
      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.effort) {
        args.push("--effort", options.effort);
      }
      args.push(...modeFlags);
      if (options.resume) {
        args.push("--resume", options.resume);
      } else if (options.sessionId) {
        args.push("--session-id", options.sessionId);
        if (options.name) {
          args.push("--name", asValue(options.name));
        }
      }
      args.push(...addDirs);
      return args;
    }
    case "codex": {
      const args = options.resume ? ["resume"] : [];
      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.effort) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
      }
      args.push(...modeFlags, "--no-alt-screen");
      if (options.resume) {
        args.push(options.resume);
      }
      if (options.prompt) {
        args.push(asValue(options.prompt));
      }
      return args;
    }
    case "copilot": {
      const args: string[] = [];
      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.effort) {
        args.push("--reasoning-effort", options.effort);
      }
      args.push(...modeFlags);
      if (options.resume) {
        args.push("--resume", options.resume);
      } else if (options.sessionId) {
        args.push("--session-id", options.sessionId);
      }
      args.push(...addDirs);
      if (options.prompt) {
        args.push("-i", asValue(options.prompt));
      }
      return args;
    }
  }
}

/** Whether the agent lets Nexura pick the id of a new session (codex's has to be found afterwards). */
export function choosesSessionId(agent: AgentKind): boolean {
  return agent !== "codex";
}
