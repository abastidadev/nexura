import type { AgentKind } from "./flow.ts";

/**
 * Permission mode of an interactive conversation. Each CLI gets its own flags for it
 * (CONVERSATION_MODE_FLAGS); `default` passes none, so the CLI uses the user's own settings.
 */
export type ConversationMode = "default" | "plan" | "acceptEdits" | "auto" | "bypass";

export const CONVERSATION_MODES: readonly ConversationMode[] = ["default", "plan", "acceptEdits", "auto", "bypass"];

export const CONVERSATION_MODE_LABELS: Record<ConversationMode, string> = {
  default: "Por defecto",
  plan: "Plan",
  acceptEdits: "Aceptar ediciones",
  auto: "Auto",
  bypass: "Sin permisos",
};

/**
 * The flags of each mode per CLI (the server launches exactly these; the UI shows them).
 * Codex has no plan flag: its plan mode is read-only. Copilot's auto is its autopilot.
 */
export const CONVERSATION_MODE_FLAGS: Record<AgentKind, Record<ConversationMode, readonly string[]>> = {
  claude: {
    default: [],
    plan: ["--permission-mode", "plan"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    auto: ["--permission-mode", "auto"],
    bypass: ["--dangerously-skip-permissions"],
  },
  codex: {
    default: [],
    plan: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
    acceptEdits: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    auto: ["--approve-for-me"],
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  copilot: {
    default: [],
    plan: ["--plan"],
    acceptEdits: ["--allow-tool", "write"],
    auto: ["--autopilot"],
    bypass: ["--yolo"],
  },
};

/** Reasoning effort levels each CLI accepts in interactive mode ("" = the CLI's default). */
export const CONVERSATION_EFFORTS: Record<AgentKind, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  copilot: ["low", "medium", "high", "xhigh", "max"],
};

/** `agent`: an interactive coding agent CLI; `shell`: a plain shell (PowerShell on Windows). */
export type ConversationKind = "agent" | "shell";

/** One stretch of a conversation spent in one agent session. Switching agent starts another one. */
export type ConversationSegment = {
  agent: AgentKind;
  /** The agent's own session id: set by Nexura for claude and copilot, detected from its session files for codex. */
  sessionId?: string;
  /** "" = the CLI's default model. */
  model: string;
  /** "" = the CLI's default effort. */
  effort: string;
  mode: ConversationMode;
  startedAt: string;
  /** When its last process ended (it can be resumed later). */
  endedAt?: string;
  /** The segment started from the history of the other agents: the file it was given. */
  handoff?: { file: string; messages: number; from: AgentKind[] };
};

export type ConversationStatus = "running" | "stopped";

/** An interactive terminal session on a project that lives on the server (it survives page reloads). */
export type Conversation = {
  id: string;
  title: string;
  /** Set once the user renames it: titles the agent generates no longer replace it. */
  titleLocked?: boolean;
  kind: ConversationKind;
  /** Repo name from config/repos.json; missing for a folder picked by hand. */
  repo?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
  exitCode?: number;
  /** Agent conversations: every agent session it went through, the current one last. */
  segments: ConversationSegment[];
  /** Command line of the running (or last) process, as launched. */
  command?: string;
  pinned?: boolean;
};

export type NewConversation = {
  kind: ConversationKind;
  repo?: string;
  /** A folder instead of a configured repo. */
  cwd?: string;
  title?: string;
  agent?: AgentKind;
  model?: string;
  effort?: string;
  mode?: ConversationMode;
  /** First message for the agent. */
  prompt?: string;
  /** Start from the history of this conversation (a fork). */
  forkOf?: string;
};

/** Restart a conversation's process, maybe with another agent, model, effort or mode. */
export type ConversationChange = {
  agent?: AgentKind;
  model?: string;
  effort?: string;
  mode?: ConversationMode;
  /** Start a new session with no history instead of resuming or handing the history over. */
  fresh?: boolean;
  /** Message for the agent when it starts (after the history, on a handoff). */
  prompt?: string;
};

export type ConversationUpdate = { title?: string; pinned?: boolean };

/** One message of a conversation, read from the session files of the agents it went through. */
export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  agent: AgentKind;
  sessionId: string;
  ts: string;
  /** Tools the assistant used in this message, e.g. "Edit src/app.ts". */
  tools?: string[];
};
