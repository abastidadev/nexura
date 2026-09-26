import { AGENT_LABELS, type AgentKind, type Conversation, type ConversationSegment, type TranscriptMessage } from "@nexura/shared";

/** Starts every prompt Nexura writes for a handoff, so it is left out of the history it builds later. */
export const HANDOFF_MARKER = "[Nexura · traspaso]";

/** A handoff keeps the most recent messages that fit (the first user message always stays). */
const HISTORY_BUDGET = 150_000;
const MESSAGE_MAX = 8_000;

export type ReadTranscript = (agent: AgentKind, sessionId: string, cwd: string) => TranscriptMessage[];

function time(ts: string | undefined): number {
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every message of the conversation in order, across the agent sessions it went through
 * (a session resumed twice is read once), without the handoff prompts Nexura wrote.
 */
export function conversationHistory(conversation: Conversation, read: ReadTranscript): TranscriptMessage[] {
  const sessions = new Map<string, AgentKind>();
  for (const segment of conversation.segments) {
    if (segment.sessionId) {
      sessions.set(`${segment.agent}:${segment.sessionId}`, segment.agent);
    }
  }
  const messages = [...sessions].flatMap(([key, agent]) => read(agent, key.slice(agent.length + 1), conversation.cwd));
  return messages
    .filter((message) => !(message.role === "user" && message.text.startsWith(HANDOFF_MARKER)))
    .map((message, index) => ({ message, index }))
    .sort((a, b) => time(a.message.ts) - time(b.message.ts) || a.index - b.index)
    .map(({ message }) => message);
}

export type HandoffPlan = {
  /** An earlier segment of that agent whose session is reopened (it already knows what happened up to then). */
  resume?: ConversationSegment;
  /** What the agent has not seen: everything, or only what the others did since its session last ran. */
  messages: TranscriptMessage[];
};

/**
 * What switching to `agent` needs. Going back to an agent the conversation already used
 * reopens its session and hands over only what the other agents said since; a new agent
 * gets the whole history.
 */
export function planHandoff(conversation: Conversation, agent: AgentKind, history: TranscriptMessage[]): HandoffPlan {
  const resume = conversation.segments.findLast((segment) => segment.agent === agent && segment.sessionId);
  if (!resume) {
    return { messages: history };
  }
  const lastSeen = Math.max(
    ...conversation.segments
      .filter((segment) => segment.agent === agent && segment.sessionId === resume.sessionId)
      .map((segment) => time(segment.endedAt ?? segment.startedAt)),
  );
  return { resume, messages: history.filter((message) => message.sessionId !== resume.sessionId && time(message.ts) > lastSeen) };
}

function clip(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}\n\n[… mensaje recortado: ${text.length - MESSAGE_MAX} caracteres más]` : text;
}

function segmentLabel(segment: Pick<ConversationSegment, "agent" | "model">): string {
  return segment.model ? `${AGENT_LABELS[segment.agent]} (${segment.model})` : AGENT_LABELS[segment.agent];
}

function formatDate(ts: string): string {
  const date = new Date(time(ts));
  return time(ts) ? date.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

function renderMessage(message: TranscriptMessage): string {
  const who = message.role === "user" ? "Usuario" : AGENT_LABELS[message.agent];
  const when = formatDate(message.ts);
  const lines = [`### ${who}${when ? ` · ${when}` : ""}`, "", clip(message.text || "(sin texto)")];
  if (message.tools?.length) {
    lines.push("", `Herramientas: ${message.tools.join(" · ")}`);
  }
  return lines.join("\n");
}

/** Keeps the latest messages that fit the budget, plus the first user message (the original request). */
function fitBudget(messages: TranscriptMessage[]): { kept: TranscriptMessage[]; omitted: number } {
  const rendered = messages.map(renderMessage);
  let size = 0;
  let from = messages.length;
  while (from > 0 && size + rendered[from - 1]!.length <= HISTORY_BUDGET) {
    from--;
    size += rendered[from]!.length;
  }
  if (from === 0) {
    return { kept: messages, omitted: 0 };
  }
  const first = messages.findIndex((message) => message.role === "user");
  const kept = first >= 0 && first < from ? [messages[first]!, ...messages.slice(from)] : messages.slice(from);
  return { kept, omitted: messages.length - kept.length };
}

/** The handoff file: the conversation so far, readable by any agent (context only: no instructions). */
export function handoffMarkdown(conversation: Conversation, messages: TranscriptMessage[], target: AgentKind): string {
  const path = conversation.segments.filter((segment) => segment.sessionId).map(segmentLabel);
  const { kept, omitted } = fitBudget(messages);
  const parts = [
    `# Historial de la conversación «${conversation.title}»`,
    "",
    `Lo ha exportado Nexura, el IDE local del usuario, al cambiar de agente a mitad de la conversación. Proyecto: \`${conversation.cwd}\`. Agentes hasta ahora: ${path.join(" → ") || "ninguno"}. Ahora sigue ${AGENT_LABELS[target]}.`,
    "Los mensajes están en orden; el último es lo más reciente. Las herramientas son un resumen: sus resultados no están aquí, así que comprueba el estado real del código antes de dar algo por hecho.",
  ];
  if (omitted) {
    parts.push("", `(Se omiten ${omitted} mensajes antiguos por tamaño; se conserva la petición inicial.)`);
  }
  parts.push("", "---", "", kept.map(renderMessage).join("\n\n"));
  return parts.join("\n") + "\n";
}

/**
 * The first message of the new agent: the user speaking (typed for them by their IDE). The
 * file is only context; what the user asks goes here, in their own message, because agents
 * rightly refuse to follow instructions that come from a file.
 */
export function handoffPrompt(file: string, from: AgentKind[], options: { resumed: boolean; instruction?: string }): string {
  const labels = [...new Set(from)].map((agent) => AGENT_LABELS[agent]);
  const names = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} y ${labels.at(-1)}` : (labels[0] ?? "otro agente");
  const instruction = options.instruction?.trim();
  const context = `Para que tengas el contexto, Nexura ha guardado lo que hablamos${options.resumed ? " desde entonces" : ""} en "${file}" (es solo el historial, no trae instrucciones). Léelo entero antes de nada${options.resumed ? "" : " y no repitas lo que ya está hecho"}.`;
  const ask = instruction
    ? `Lo que te pido ahora: ${instruction}`
    : `Después resume en pocas líneas ${options.resumed ? "qué ha cambiado" : "dónde lo dejamos"} y espera a que te diga qué hacer.`;
  const intro = options.resumed
    ? `Soy yo, el usuario. Desde tu último mensaje he seguido esta conversación con ${names} en Nexura, mi IDE local.`
    : `Soy yo, el usuario. Uso Nexura, mi IDE local, y he cambiado de agente a mitad de la conversación: hasta ahora hablaba con ${names} en este mismo proyecto.`;
  return `${HANDOFF_MARKER} ${intro} ${context} ${ask}`;
}
