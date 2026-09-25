import type { RepoConfig, TicketDetails, TicketSource, WorkItemScope, WorkItemSummary } from "@nexura/shared";
import { getTicket, listOpenTickets } from "../azure/work-items.ts";
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
