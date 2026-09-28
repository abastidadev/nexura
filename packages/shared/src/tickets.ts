import type { AgentKind, Effort, TicketSource } from "./flow.ts";

/**
 * The two kinds of item the ticket assistant writes, each for the frontend or the backend
 * (the format of the ai-toolkit `create-work-item` skill): a story is new or changed
 * behaviour, a bug is something broken. Work on both sides is two linked items.
 */
export type TicketKind = "story" | "bug";

export const TICKET_KINDS: readonly TicketKind[] = ["story", "bug"];

export type TicketSide = "frontend" | "backend";

export const TICKET_SIDES: readonly TicketSide[] = ["frontend", "backend"];

export const TICKET_KIND_LABELS: Record<TicketKind, string> = { story: "Historia de usuario", bug: "Bug" };

export const TICKET_SIDE_LABELS: Record<TicketSide, string> = { frontend: "Frontend", backend: "Backend" };

/** A work item or issue created from a draft. */
export type CreatedTicket = { id: number; url: string };

/**
 * One item of a draft. The texts are light markdown (`**Heading:**`, nested `-` lists,
 * numbered steps), turned into HTML for Azure DevOps and kept as is for GitHub.
 */
export type TicketItem = {
  key: string;
  side: TicketSide;
  kind: TicketKind;
  title: string;
  /** Story: Functionality + User Functionality. Always empty for a bug. */
  description: string;
  /** Story: what the task includes and what it does NOT include. */
  acceptanceCriteria: string;
  /** Bug: error description, numbered steps, expected behaviour (and the fix scope). */
  reproSteps: string;
  /** Azure tags or GitHub labels. */
  tags: string[];
  /** Configured repo: where the issue goes (GitHub), the project (Azure) and the flow launched afterwards. */
  repo: string;
  /** Azure iteration path or GitHub milestone number; "" = backlog, no sprint. */
  iteration: string;
  /** Azure uniqueName or GitHub login; "" = nobody. */
  assignee: string;
  /** Azure area path; "" = the team's default. */
  areaPath: string;
  /** Azure team whose sprints and members are offered; missing = the project's default team. */
  team?: string;
  created?: CreatedTicket;
};

/** A question of the assistant with the answers it suggests (one click in the UI). */
export type TicketQuestion = { text: string; options: string[] };

export type TicketChatMessage = { role: "user" | "assistant"; text: string; questions?: TicketQuestion[]; at: string };

/** Who drafts: any of the headless agents, read-only on the repo. */
export type TicketAssistantAgent = { agent: AgentKind; model: string; effort: Effort };

export const DEFAULT_TICKET_ASSISTANT: TicketAssistantAgent = { agent: "claude", model: "sonnet", effort: "medium" };

/** `created` = every item is on the board; `error` = the last turn or creation failed (the draft is kept). */
export type TicketDraftStatus = "thinking" | "idle" | "error" | "created";

/** A ticket being written with the assistant: the conversation and the items it fills in. */
export type TicketDraft = {
  id: string;
  /** Repo it started from: its origin remote decides the provider. */
  repo: string;
  source: TicketSource;
  kind: TicketKind;
  /** What the user wrote first, in their own words. */
  idea: string;
  agent: TicketAssistantAgent;
  /** Agent session, resumed on every turn. */
  sessionId?: string;
  messages: TicketChatMessage[];
  /** One item, or two (frontend + backend) linked to each other. */
  items: TicketItem[];
  /** The assistant thinks the work lands on both sides. */
  suggestSplit: boolean;
  /** What the assistant still needs, in plain Spanish. */
  missing: string[];
  ready: boolean;
  status: TicketDraftStatus;
  /** What the assistant is doing right now (not persisted). */
  activity?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type NewTicketDraft = { repo: string; kind: TicketKind; idea: string; agent?: TicketAssistantAgent };

/** What the user can edit by hand: the items' texts, tags and where they go. */
export type TicketDraftUpdate = { items: TicketItem[] };

/** A work item or issue already on the board, shown to the assistant as the team's style. */
export type TicketSample = {
  id: number;
  title: string;
  type: string;
  state: string;
  area?: string;
  iteration?: string;
  tags: string[];
  /** Only the latest few carry their texts. */
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
};

export type TicketIteration ={ value: string; name: string; start?: string; end?: string; current: boolean };

/** Where a repo's tickets go and what can be picked there (REST, zero tokens). */
export type TicketOptions = {
  source: TicketSource;
  /** Azure DevOps project, or `owner/repo` on GitHub. */
  target: string;
  /** Work item type (Azure: depends on the process) or GitHub issue type ("" = none) for each kind. */
  types: Record<TicketKind, string>;
  /** Azure teams of the project (empty on GitHub). */
  teams: string[];
  team?: string;
  /** Current and future sprints (Azure) or open milestones (GitHub). */
  iterations: TicketIteration[];
  /** Who can be assigned: team members (Azure) or assignable users (GitHub). */
  people: { value: string; name: string }[];
  /** The signed-in user's `value` among `people`. */
  me?: string;
  /** GitHub labels of the repo (empty on Azure: tags are free text). */
  labels: string[];
  /** The team's default area path (Azure). */
  areaPath?: string;
};
