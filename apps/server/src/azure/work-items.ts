import type { TicketDetails } from "@nexura/shared";
import { azureRequest } from "./azure-client.ts";
import { htmlToText } from "./html-to-text.ts";

const CHILD_RELATION = "System.LinkTypes.Hierarchy-Forward";
const MAX_COMMENTS = 10;
const CLOSED_STATES = new Set(["Closed", "Done", "Removed", "Resolved"]);

type WorkItem = {
  id: number;
  fields: Record<string, unknown>;
  relations?: { rel: string; url: string }[];
  _links?: { html?: { href?: string } };
};

type CommentList = { comments: { text: string; createdBy?: { displayName?: string }; createdDate?: string }[] };

const field = (item: WorkItem, name: string): string => String(item.fields[name] ?? "");

/**
 * Reads a work item the way the `work-item` skill asks for: description, acceptance
 * criteria (or repro steps), the latest comments and the child tasks. Plain REST, no tokens.
 * A get by id works whichever project holds the item.
 */
export async function getTicket(organization: string, id: number): Promise<TicketDetails> {
  const item = await azureRequest<WorkItem>(organization, `_apis/wit/workitems/${id}?$expand=relations`);
  const project = field(item, "System.TeamProject");

  const childIds = (item.relations ?? [])
    .filter((relation) => relation.rel === CHILD_RELATION)
    .map((relation) => Number(relation.url.split("/").at(-1)))
    .filter(Number.isFinite);
  const children = childIds.length
    ? (
        await azureRequest<{ value: WorkItem[] }>(
          organization,
          `_apis/wit/workitems?ids=${childIds.join(",")}&fields=System.Id,System.Title,System.State,System.WorkItemType`,
        )
      ).value
    : [];

  let comments: TicketDetails["comments"] = [];
  try {
    const list = await azureRequest<CommentList>(
      organization,
      `${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?$top=${MAX_COMMENTS}&order=desc`,
      { apiVersion: "7.1-preview.4" },
    );
    comments = list.comments
      .map((comment) => ({
        author: comment.createdBy?.displayName ?? "",
        date: comment.createdDate ?? "",
        text: htmlToText(comment.text),
      }))
      .reverse();
  } catch {
    // Comments are a nice-to-have; the ticket is still usable without them.
  }

  const type = field(item, "System.WorkItemType");
  const description = htmlToText(field(item, "System.Description"));
  const acceptance = htmlToText(field(item, "Microsoft.VSTS.Common.AcceptanceCriteria"));
  const repro = htmlToText(field(item, "Microsoft.VSTS.TCM.ReproSteps"));

  return {
    id,
    type,
    title: field(item, "System.Title"),
    state: field(item, "System.State"),
    project,
    url: item._links?.html?.href ?? `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
    description,
    acceptanceCriteria: acceptance,
    reproSteps: repro,
    comments,
    children: children.map((child) => ({
      id: child.id,
      title: field(child, "System.Title"),
      state: field(child, "System.State"),
      type: field(child, "System.WorkItemType"),
      done: CLOSED_STATES.has(field(child, "System.State")),
    })),
  };
}

/** The ticket as the text the flow works from (title first, as the form expects). */
export function ticketToText(ticket: TicketDetails): string {
  const sections = [`${ticket.title}`, `${ticket.type} · ${ticket.state} · ${ticket.project}`];
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
