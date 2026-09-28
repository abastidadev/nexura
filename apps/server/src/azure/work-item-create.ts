import type { CreatedTicket, TicketItem, TicketIteration, TicketKind, TicketOptions, TicketSample } from "@nexura/shared";
import { azureRequest } from "./azure-client.ts";
import { htmlToText } from "./html-to-text.ts";
import { markdownToHtml } from "./text-to-html.ts";

/** The story type of each process (Agile, Scrum, CMMI, Basic), in that order of preference. */
const STORY_TYPES = ["User Story", "Product Backlog Item", "Requirement", "Issue"];
const DESCRIPTION = "System.Description";
const ACCEPTANCE = "Microsoft.VSTS.Common.AcceptanceCriteria";
const REPRO = "Microsoft.VSTS.TCM.ReproSteps";
const RELATED = "System.LinkTypes.Related";
const MAX_SAMPLES = 18;
const FULL_SAMPLES = 3;
const MAX_SAMPLE_TEXT = 1500;

type Named = { name: string };
type IterationNode = { name: string; path: string; attributes?: { startDate?: string; finishDate?: string; timeFrame?: string | number } };
type Member = { identity?: { displayName?: string; uniqueName?: string; isContainer?: boolean } };
type ConnectionData = { authenticatedUser?: { providerDisplayName?: string; properties?: { Account?: { $value?: string } } } };
type WorkItem = { id: number; url?: string; fields: Record<string, unknown>; _links?: { html?: { href?: string } } };

const enc = encodeURIComponent;
const field = (item: WorkItem, name: string): string => String(item.fields[name] ?? "");
const clip = (text: string): string => (text.length > MAX_SAMPLE_TEXT ? `${text.slice(0, MAX_SAMPLE_TEXT)}…` : text);
const splitTags = (tags: string): string[] => tags.split(";").map((tag) => tag.trim()).filter(Boolean);

/** `past | current | future`, as a string or as the enum's number depending on the server. */
const timeFrameOf = (node: IterationNode): string => {
  const frame = node.attributes?.timeFrame;
  return typeof frame === "number" ? (["past", "current", "future"][frame] ?? "") : (frame ?? "");
};

/** The teams of the project and the one to use: the wanted one if it exists, else the project's default team. */
async function resolveTeam(organization: string, project: string, wanted?: string): Promise<{ teams: string[]; team?: string }> {
  const [info, list] = await Promise.all([
    azureRequest<{ defaultTeam?: Named }>(organization, `_apis/projects/${enc(project)}`),
    azureRequest<{ value: Named[] }>(organization, `_apis/projects/${enc(project)}/teams?$top=200`),
  ]);
  const teams = list.value.map((team) => team.name).sort((a, b) => a.localeCompare(b));
  const team = wanted && teams.includes(wanted) ? wanted : (info.defaultTeam?.name ?? teams[0]);
  return { teams, team };
}

/** Work item types of each kind in this project's process. */
async function kindTypes(organization: string, project: string): Promise<Record<TicketKind, string>> {
  const { value } = await azureRequest<{ value: (Named & { isDisabled?: boolean })[] }>(organization, `${enc(project)}/_apis/wit/workitemtypes`);
  const available = new Set(value.filter((type) => !type.isDisabled).map((type) => type.name));
  const story = STORY_TYPES.find((type) => available.has(type)) ?? "User Story";
  return { story, bug: available.has("Bug") ? "Bug" : story };
}

/** The team's default area path (where its backlog lives), when the team is organised by area. */
async function teamArea(organization: string, project: string, team: string): Promise<string | undefined> {
  const values = await azureRequest<{ field?: { referenceName?: string }; defaultValue?: string }>(
    organization,
    `${enc(project)}/${enc(team)}/_apis/work/teamsettings/teamfieldvalues`,
  );
  return values.field?.referenceName === "System.AreaPath" ? values.defaultValue : undefined;
}

/**
 * What can be picked for a new work item of the project: the team's current and future
 * sprints, its members, its default area and the process's types. Plain REST, no tokens.
 * Each part is optional: a team without sprints or a missing permission leaves it empty.
 */
export async function ticketOptionsAzure(organization: string, project: string, wantedTeam?: string): Promise<TicketOptions> {
  const [{ teams, team }, types, connection] = await Promise.all([
    resolveTeam(organization, project, wantedTeam),
    kindTypes(organization, project),
    azureRequest<ConnectionData>(organization, "_apis/connectionData", { apiVersion: "7.1-preview.1" }).catch(() => undefined),
  ]);
  const [iterations, members, areaPath] = team
    ? await Promise.all([
        azureRequest<{ value: IterationNode[] }>(organization, `${enc(project)}/${enc(team)}/_apis/work/teamsettings/iterations`)
          .then(({ value }) => value)
          .catch(() => []),
        azureRequest<{ value: Member[] }>(organization, `_apis/projects/${enc(project)}/teams/${enc(team)}/members?$top=500`)
          .then(({ value }) => value)
          .catch(() => []),
        teamArea(organization, project, team).catch(() => undefined),
      ])
    : [[], [], undefined];

  const people = members
    .map((member) => member.identity)
    .filter((identity) => identity?.uniqueName && !identity.isContainer)
    .map((identity) => ({ value: identity!.uniqueName!, name: identity!.displayName || identity!.uniqueName! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const account = connection?.authenticatedUser?.properties?.Account?.$value;
  const me = people.find((person) => person.value.toLowerCase() === account?.toLowerCase())?.value ?? account;

  return {
    source: "azure",
    target: project,
    types,
    teams,
    team,
    iterations: iterations
      .filter((node) => timeFrameOf(node) !== "past")
      .map((node): TicketIteration => ({
        value: node.path,
        name: node.name,
        start: node.attributes?.startDate,
        end: node.attributes?.finishDate,
        current: timeFrameOf(node) === "current",
      })),
    people,
    me,
    labels: [],
    areaPath,
  };
}

/**
 * The latest items of `type` in the project, closed ones included: the team's style (title
 * shape and prefix, area, tags, depth). The first few carry their texts. Plain REST, no tokens.
 */
export async function similarWorkItems(organization: string, project: string, type: string): Promise<TicketSample[]> {
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${type.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`;
  const { workItems } = await azureRequest<{ workItems: { id: number }[] }>(organization, `${enc(project)}/_apis/wit/wiql?$top=${MAX_SAMPLES}`, {
    method: "POST",
    body: { query },
  });
  const ids = workItems.slice(0, MAX_SAMPLES).map((item) => item.id);
  if (!ids.length) {
    return [];
  }
  const fields = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AreaPath", "System.IterationPath", "System.Tags", DESCRIPTION, ACCEPTANCE, REPRO];
  const { value } = await azureRequest<{ value: WorkItem[] }>(organization, `_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&errorPolicy=omit`);
  const byId = new Map(value.filter(Boolean).map((item) => [item.id, item]));
  return ids
    .map((id) => byId.get(id))
    .filter((item): item is WorkItem => Boolean(item))
    .map((item, index) => ({
      id: item.id,
      title: field(item, "System.Title"),
      type: field(item, "System.WorkItemType"),
      state: field(item, "System.State"),
      area: field(item, "System.AreaPath"),
      iteration: field(item, "System.IterationPath"),
      tags: splitTags(field(item, "System.Tags")),
      ...(index < FULL_SAMPLES
        ? {
            description: clip(htmlToText(field(item, DESCRIPTION))),
            acceptanceCriteria: clip(htmlToText(field(item, ACCEPTANCE))),
            reproSteps: clip(htmlToText(field(item, REPRO))),
          }
        : {}),
    }));
}

/** REST url of a work item: what a relation points to. */
export function workItemApiUrl(organization: string, id: number): string {
  return `https://dev.azure.com/${organization}/_apis/wit/workItems/${id}`;
}

/**
 * The fields of the draft item as Azure DevOps keeps them, each in its own field: a story in
 * Description + Acceptance Criteria, a bug in Repro Steps with the Description empty. A text
 * whose field the type lacks (another process) goes into the Description instead.
 */
export function workItemContent(item: TicketItem, typeFields: ReadonlySet<string>): Record<string, string> {
  const content: Record<string, string> = {};
  const extra: string[] = [];
  const put = (reference: string, text: string): void => {
    if (!text.trim()) {
      return;
    }
    if (typeFields.has(reference)) {
      content[reference] = markdownToHtml(text);
    } else {
      extra.push(text);
    }
  };
  if (item.kind === "story") {
    put(ACCEPTANCE, item.acceptanceCriteria);
  } else {
    put(REPRO, item.reproSteps);
  }
  const description = [item.kind === "story" ? item.description : "", ...extra].filter((text) => text.trim()).join("\n\n");
  if (description) {
    content[DESCRIPTION] = markdownToHtml(description);
  }
  return content;
}

/**
 * Creates the item on the board: state New (the team triages it), in the chosen sprint and
 * area, assigned only when the user picked someone, related to `relatedUrl` if given.
 */
export async function createWorkItem(
  organization: string,
  project: string,
  item: TicketItem,
  options: Pick<TicketOptions, "types" | "areaPath">,
  relatedUrl?: string,
): Promise<CreatedTicket> {
  const type = options.types[item.kind];
  const { value } = await azureRequest<{ value: { referenceName: string }[] }>(organization, `${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/fields`);
  const typeFields = new Set(value.map((entry) => entry.referenceName));
  const operations: { op: "add"; path: string; value: unknown }[] = [{ op: "add", path: "/fields/System.Title", value: item.title.trim() }];
  for (const [reference, html] of Object.entries(workItemContent(item, typeFields))) {
    operations.push({ op: "add", path: `/fields/${reference}`, value: html });
  }
  const areaPath = item.areaPath || options.areaPath;
  if (areaPath) {
    operations.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
  }
  if (item.iteration) {
    operations.push({ op: "add", path: "/fields/System.IterationPath", value: item.iteration });
  }
  if (item.assignee) {
    operations.push({ op: "add", path: "/fields/System.AssignedTo", value: item.assignee });
  }
  if (item.tags.length) {
    operations.push({ op: "add", path: "/fields/System.Tags", value: item.tags.join("; ") });
  }
  if (relatedUrl) {
    operations.push({ op: "add", path: "/relations/-", value: { rel: RELATED, url: relatedUrl } });
  }
  const created = await azureRequest<WorkItem>(organization, `${enc(project)}/_apis/wit/workitems/$${enc(type)}`, {
    method: "POST",
    body: operations,
    contentType: "application/json-patch+json",
  });
  return {
    id: created.id,
    url: created._links?.html?.href ?? `https://dev.azure.com/${organization}/${enc(project)}/_workitems/edit/${created.id}`,
  };
}
