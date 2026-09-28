import type {
  CreatedTicket,
  RepoConfig,
  TicketDetails,
  TicketItem,
  TicketKind,
  TicketOptions,
  TicketSample,
  TicketSource,
  WorkItemScope,
  WorkItemSummary,
} from "@nexura/shared";
import { createWorkItem, similarWorkItems, ticketOptionsAzure, workItemApiUrl } from "../azure/work-item-create.ts";
import { getTicket, listOpenTickets } from "../azure/work-items.ts";
import { createIssue, similarIssues, ticketOptionsGithub } from "../github/issue-create.ts";
import { getIssue, listOpenIssues } from "../github/issues.ts";
import { parseOwnerRepo } from "../github/repo-remote.ts";
import { PROVIDER_LABEL, repoRemoteOf } from "./remote.ts";

/** Where to read tickets from: an Azure DevOps organisation (and project) or a GitHub repo. */
export type TicketTarget =
  | { source: "azure"; organization: string; project?: string }
  | { source: "github"; owner: string; repo: string };

/**
 * The chosen repo's origin remote when it is on `source` (or the first repo that is), else
 * NEXURA_AZURE_ORG[/NEXURA_AZURE_PROJECT] or NEXURA_GITHUB_REPO (`owner/repo`), so tickets
 * can live on a different provider than the code.
 */
export async function ticketTarget(source: TicketSource, repos: RepoConfig[], wanted: string | null): Promise<TicketTarget> {
  for (const repo of wanted ? repos.filter((candidate) => candidate.name === wanted) : repos) {
    const remote = await repoRemoteOf(repo.path);
    if (remote?.provider === "azure" && source === "azure") {
      return { source, organization: remote.organization, project: remote.project };
    }
    if (remote?.provider === "github" && source === "github") {
      return { source, owner: remote.owner, repo: remote.repo };
    }
  }
  if (source === "azure" && process.env.NEXURA_AZURE_ORG) {
    return { source, organization: process.env.NEXURA_AZURE_ORG, project: process.env.NEXURA_AZURE_PROJECT };
  }
  const fallback = parseOwnerRepo(process.env.NEXURA_GITHUB_REPO);
  if (source === "github" && fallback) {
    return { source, ...fallback };
  }
  const env = source === "azure" ? "NEXURA_AZURE_ORG" : "NEXURA_GITHUB_REPO";
  const which = wanted ? `El repo ${wanted} no tiene` : "Ningún repo tiene";
  throw new Error(`${which} un remote origin de ${PROVIDER_LABEL[source]} (o define ${env})`);
}

/** Loads a work item or an issue. Zero tokens. */
export function loadTicket(target: TicketTarget, id: number): Promise<TicketDetails> {
  return target.source === "azure" ? getTicket(target.organization, id) : getIssue(target, id);
}

/** Open work items or issues for the picker. Zero tokens. */
export function listTickets(target: TicketTarget, scope: WorkItemScope): Promise<WorkItemSummary[]> {
  return target.source === "azure" ? listOpenTickets(target.organization, scope, target.project) : listOpenIssues(target, scope);
}

function projectOf(target: Extract<TicketTarget, { source: "azure" }>): string {
  if (!target.project) {
    throw new Error("Falta el proyecto de Azure DevOps (define NEXURA_AZURE_PROJECT o usa un repo de Azure DevOps)");
  }
  return target.project;
}

/** Sprints, people, types, labels and default area for a new ticket. Zero tokens. */
export function ticketOptions(target: TicketTarget, team?: string): Promise<TicketOptions> {
  return target.source === "azure" ? ticketOptionsAzure(target.organization, projectOf(target), team) : ticketOptionsGithub(target);
}

/** The latest tickets of that kind on the board, as the team's style for the assistant. Zero tokens. */
export function similarTickets(target: TicketTarget, kind: TicketKind, types: TicketOptions["types"]): Promise<TicketSample[]> {
  return target.source === "azure" ? similarWorkItems(target.organization, projectOf(target), types[kind]) : similarIssues(target, kind, types);
}

/**
 * Creates the items that are not on the board yet, in order, each linked to the one created
 * before it (Azure: a Related link; GitHub: a `Related:` line on both). `saved` runs after each
 * one, so a failure halfway keeps what was created and a retry does not duplicate it.
 */
export async function createTickets(
  items: TicketItem[],
  targetOf: (item: TicketItem) => Promise<TicketTarget>,
  saved: (items: TicketItem[]) => void,
): Promise<TicketItem[]> {
  const result = items.map((item) => ({ ...item }));
  for (const item of result) {
    if (item.created) {
      continue;
    }
    const target = await targetOf(item);
    const options = await ticketOptions(target, item.team);
    const previous = result.find((other) => other !== item && other.created);
    const previousTarget = previous ? await targetOf(previous) : undefined;
    let created: CreatedTicket;
    if (target.source === "azure") {
      const relatedUrl = previous && previousTarget?.source === "azure" ? workItemApiUrl(previousTarget.organization, previous.created!.id) : undefined;
      created = await createWorkItem(target.organization, projectOf(target), item, options, relatedUrl);
    } else {
      const related = previous && previousTarget?.source === "github" ? { remote: previousTarget, number: previous.created!.id } : undefined;
      created = await createIssue(target, item, options, related);
    }
    item.created = created;
    saved(result);
  }
  return result;
}

/** The ticket as the text the flow works from (title first, as the form expects). */
export function ticketToText(ticket: TicketDetails): string {
  const sections = [`${ticket.title}`, `${ticket.type} · ${ticket.state} · ${ticket.project}`];
  if (ticket.labels?.length) {
    sections.push(`Etiquetas: ${ticket.labels.join(", ")}`);
  }
  if (ticket.description) {
    sections.push(`## Descripción\n${ticket.description}`);
  }
  if (ticket.acceptanceCriteria) {
    sections.push(`## Criterios de aceptación\n${ticket.acceptanceCriteria}`);
  }
  if (ticket.reproSteps) {
    sections.push(`## Pasos para reproducir\n${ticket.reproSteps}`);
  }
  if (ticket.comments.length) {
    sections.push(
      `## Comentarios\n${ticket.comments.map((comment) => `- ${comment.author} (${comment.date.slice(0, 10)}): ${comment.text}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
