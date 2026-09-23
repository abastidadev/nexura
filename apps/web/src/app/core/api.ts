import { HttpClient } from "@angular/common/http";
import { inject, Service } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type {
  FlowProfile,
  Metrics,
  NexuraEvent,
  QuotaInfo,
  RepoConfig,
  RetryOptions,
  ReviewThread,
  Run,
  RunRequest,
  StepDefinition,
  TicketDetails,
} from "@nexura/shared";

export type StoredEvent = { seq: number; ts: string; event: NexuraEvent };

export type StepDefinitionView = StepDefinition & { promptTemplate?: string; schema?: object };

export type NexuraConfigView = {
  profiles: FlowProfile[];
  repos: RepoConfig[];
  steps: StepDefinitionView[];
};

export type StepDefinitionEdit = Pick<StepDefinition, "tools" | "allowedTools" | "disallowedTools" | "useMcp" | "timeoutMs">;

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

  public cancel(runId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/runs/${runId}/cancel`, {}));
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
