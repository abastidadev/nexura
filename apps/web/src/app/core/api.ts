import { HttpClient } from "@angular/common/http";
import { inject, Service } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type {
  FlowProfile,
  Metrics,
  NexuraEvent,
  MemoryObservation,
  NexuraSettings,
  QuotaInfo,
  RepoConfig,
  RetryOptions,
  ReviewThread,
  Run,
  RunRequest,
  StepDefinition,
  TicketDetails,
  WorkItemScope,
  WorkItemSummary,
} from "@nexura/shared";

export type StoredEvent = { seq: number; ts: string; event: NexuraEvent };

export type StepDefinitionView = StepDefinition & { promptTemplate?: string; schema?: object };

export type NexuraConfigView = {
  profiles: FlowProfile[];
  repos: RepoConfig[];
  steps: StepDefinitionView[];
};

export type StepDefinitionEdit = Pick<StepDefinition, "tools" | "allowedTools" | "disallowedTools" | "useMcp" | "timeoutMs"> &
  Partial<Pick<StepDefinition, "memory">> &
  Partial<Pick<StepDefinition, "label" | "description" | "after">>;

export type NewStep = { name: string; label?: string; description?: string; after: string };

/** Server error message from an HttpErrorResponse, with a fallback. */
export function apiError(error: unknown, fallback: string): string {
  return (error as { error?: { error?: string } }).error?.error ?? fallback;
}

export type CostByStep = { step: string; model: string; runs: number; costUsd: number; avgTurns: number };

/** Thin typed client of the Nexura server REST API. */
@Service()
export class Api {
  private readonly http = inject(HttpClient);

  public listRuns(): Promise<Run[]> {
    return firstValueFrom(this.http.get<Run[]>("/api/runs"));
  }

  public getRun(id: string): Promise<Run> {
    return firstValueFrom(this.http.get<Run>(`/api/runs/${id}`));
  }

  public getEvents(runId: string, stepRunId: string, after = -1): Promise<StoredEvent[]> {
    return firstValueFrom(
      this.http.get<StoredEvent[]>(`/api/runs/${runId}/steps/${stepRunId}/events`, { params: { after } }),
    );
  }

  public getRaw(runId: string, stepRunId: string): Promise<string> {
    return firstValueFrom(this.http.get<{ jsonl: string }>(`/api/runs/${runId}/steps/${stepRunId}/raw`)).then(
      (response) => response.jsonl,
    );
  }

  public getLedger(runId: string): Promise<string> {
    return firstValueFrom(this.http.get<{ markdown: string }>(`/api/runs/${runId}/ledger`)).then(
      (response) => response.markdown,
    );
  }

  public startRun(request: RunRequest): Promise<Run> {
    return firstValueFrom(this.http.post<Run>("/api/runs", request));
  }

  /** History, logs and worktrees; the branches stay unless `deleteBranches`. */
  public deleteRun(runId: string, deleteBranches = false): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/runs/${runId}`, { params: { deleteBranches } }));
  }

  public cancel(runId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/runs/${runId}/cancel`, {}));
  }

  /** Message for the claude step that is running right now (joins its current turn). */
  public sendMessage(runId: string, text: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/runs/${runId}/message`, { text }));
  }

  public continue(runId: string, options?: RetryOptions): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/runs/${runId}/continue`, options ?? {}));
  }

  public retry(runId: string, options: RetryOptions): Promise<Run> {
    return firstValueFrom(this.http.post<Run>(`/api/runs/${runId}/retry`, options));
  }

  public reviewThreads(runId: string): Promise<ReviewThread[]> {
    return firstValueFrom(this.http.get<ReviewThread[]>(`/api/runs/${runId}/review-threads`));
  }

  public addressReview(runId: string): Promise<Run> {
    return firstValueFrom(this.http.post<Run>(`/api/runs/${runId}/address-review`, {}));
  }

  public cleanup(runId: string, deleteBranches: boolean): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/runs/${runId}/cleanup`, { deleteBranches }));
  }

  public getConfig(): Promise<NexuraConfigView> {
    return firstValueFrom(this.http.get<NexuraConfigView>("/api/config"));
  }

  public saveProfile(profile: FlowProfile): Promise<FlowProfile> {
    return firstValueFrom(this.http.put<FlowProfile>(`/api/profiles/${profile.name}`, profile));
  }

  public deleteProfile(name: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/profiles/${name}`));
  }

  public createStep(step: NewStep): Promise<void> {
    return firstValueFrom(this.http.post<void>("/api/steps", step));
  }

  /** Only custom steps; also takes it out of every profile. */
  public deleteStep(step: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/steps/${encodeURIComponent(step)}`));
  }

  public saveStepPrompt(step: string, template: string): Promise<void> {
    return firstValueFrom(this.http.put<void>(`/api/steps/${step}/prompt`, { template }));
  }

  public saveStepDefinition(step: string, definition: StepDefinitionEdit): Promise<void> {
    return firstValueFrom(this.http.put<void>(`/api/steps/${step}/definition`, definition));
  }

  public saveRepos(repos: RepoConfig[]): Promise<void> {
    return firstValueFrom(this.http.put<void>("/api/repos", { repos }));
  }

  public loadWorkItem(id: string, repo?: string): Promise<{ ticket: TicketDetails; text: string }> {
    const params: Record<string, string> = repo ? { repo } : {};
    return firstValueFrom(
      this.http.get<{ ticket: TicketDetails; text: string }>(`/api/azure/work-items/${encodeURIComponent(id)}`, { params }),
    );
  }

  /** Open tickets (backlog + in progress) of the repo's Azure DevOps organisation/project. */
  public listWorkItems(scope: WorkItemScope, repo?: string): Promise<WorkItemSummary[]> {
    const params: Record<string, string> = repo ? { scope, repo } : { scope };
    return firstValueFrom(this.http.get<WorkItemSummary[]>("/api/azure/work-items", { params }));
  }

  /** Native folder dialog on the Nexura machine; "" when cancelled. */
  public pickFolder(initial = ""): Promise<string> {
    return firstValueFrom(this.http.post<{ path: string }>("/api/system/pick-folder", { initial })).then((response) => response.path);
  }

  public getSettings(): Promise<NexuraSettings> {
    return firstValueFrom(this.http.get<NexuraSettings>("/api/settings"));
  }

  public saveSettings(settings: Partial<NexuraSettings>): Promise<NexuraSettings> {
    return firstValueFrom(this.http.put<NexuraSettings>("/api/settings", settings));
  }

  public getRepoNotes(repo: string): Promise<string> {
    return firstValueFrom(this.http.get<{ markdown: string }>(`/api/repos/${encodeURIComponent(repo)}/notes`)).then((r) => r.markdown);
  }

  public saveRepoNotes(repo: string, markdown: string): Promise<void> {
    return firstValueFrom(this.http.put<void>(`/api/repos/${encodeURIComponent(repo)}/notes`, { markdown }));
  }

  /** Shared memory of a repo: a full-text search, or the latest when `query` is empty. */
  public searchMemory(repo: string, query: string): Promise<{ project: string; observations: MemoryObservation[] }> {
    return firstValueFrom(this.http.get<{ project: string; observations: MemoryObservation[] }>("/api/memory", { params: { repo, q: query } }));
  }

  public deleteMemory(id: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/memory/${id}`));
  }

  /** `claude mcp add ...` to give the interactive Claude Code the same memory. */
  public memoryMcpCommand(): Promise<string> {
    return firstValueFrom(this.http.get<{ command: string }>("/api/memory/mcp")).then((r) => r.command);
  }

  public getQuota(): Promise<QuotaInfo | null> {
    return firstValueFrom(this.http.get<QuotaInfo | null>("/api/quota"));
  }

  public metrics(days = 14): Promise<Metrics> {
    return firstValueFrom(this.http.get<Metrics>("/api/metrics", { params: { days } }));
  }

  public rateClassify(runId: string, correct: boolean, expected?: string): Promise<Run> {
    return firstValueFrom(this.http.post<Run>(`/api/runs/${runId}/classify-feedback`, { correct, expected }));
  }

  public costByStep(): Promise<CostByStep[]> {
    return firstValueFrom(this.http.get<CostByStep[]>("/api/metrics/cost-by-step"));
  }
}
