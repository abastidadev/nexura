import { Component, computed, effect, inject, input, linkedSignal, resource, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { AGENT_KINDS, AGENT_LABELS, AGENT_MODELS, modelsFor, orderSteps, type AgentKind, type Effort, type FlowProfile, type TaskItem, type TicketDetails, type TicketSource } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { modelDetail, stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { SOURCE_LABELS, TicketPicker } from "./ticket-picker";
import { Icon } from "../../shared/icon";
import { ModelPicker } from "../../shared/model-picker";

/** Default choice: one agent runs every step of BASE_PROFILE with its model and effort. */
const SINGLE_AGENT = "single-agent";
const BASE_PROFILE = "standard";

type ProfileCard = {
  name: string;
  title: string;
  description: string;
  steps: { label: string; detail: string }[];
  maxLoops?: number;
};
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;

@Component({
  selector: "nx-new-run",
  imports: [TicketPicker, Icon, ModelPicker],
  templateUrl: "./new-run.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class NewRun {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  /** `/new?ticket=15&source=github&repo=nexura` (from the Panel) opens the form with that ticket loaded. */
  public readonly ticket = input<string>();
  public readonly source = input<string>();
  public readonly repo = input<string>();
  private prefilled = false;

  protected readonly ticketId = signal("");
  protected readonly ticketText = signal("");
  protected readonly prompt = signal("");
  protected readonly tasks = signal<TaskItem[]>([]);
  protected readonly newTask = signal("");
  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly efforts: readonly Effort[] = ["low", "medium", "high", "xhigh"];
  protected readonly agent = signal<AgentKind>("claude");
  protected readonly model = signal("opus");
  protected readonly effort = signal<Effort>("medium");
  private readonly agentInfo = resource({ loader: () => this.api.getAgents() });
  protected readonly agentModels = computed(() => modelsFor(this.agent(), this.agentInfo.hasValue() ? this.agentInfo.value() : undefined));
  protected readonly profile = signal(SINGLE_AGENT);
  protected readonly singleAgent = SINGLE_AGENT;
  /** Per-step plans, for whoever wants other steps or to mix agents. Cheapest first: fewer enabled steps, then fewer loops. */
  protected readonly profiles = computed<ProfileCard[]>(() =>
    [...(this.store.config()?.profiles ?? [])]
      .sort((a, b) => this.enabledCount(a) - this.enabledCount(b) || a.maxLoops - b.maxLoops)
      .map((profile) => this.toCard(profile)),
  );
  protected readonly stepByStep = signal(false);
  protected readonly createPr = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  // ---- Azure DevOps work item or GitHub issue
  protected readonly loadedTicket = signal<TicketDetails | null>(null);
  protected readonly loadingTicket = signal(false);
  protected readonly ticketError = signal<string | null>(null);
  protected readonly pickerOpen = signal(false);
  protected readonly sources = Object.entries(SOURCE_LABELS).map(([id, label]) => ({ id: id as TicketSource, label }));

  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  /** Pre-selects the only repo when there is just one. */
  protected readonly selectedRepos = linkedSignal<string[]>(() => {
    const repos = this.repos();
    return repos.length === 1 ? [repos[0]!.name] : [];
  });

  /** Provider of the first selected repo's origin remote: the default ticket source. */
  private readonly repoProvider = resource({
    params: () => this.selectedRepos()[0],
    loader: ({ params }) => this.api.repoProvider(params),
  });
  /** Follows the first repo's provider; the user can switch (e.g. code on Azure, issues on GitHub). */
  protected readonly ticketSource = linkedSignal<TicketSource | null | undefined, TicketSource>({
    source: () => (this.repoProvider.hasValue() ? this.repoProvider.value() : undefined),
    computation: (provider, previous) => provider ?? previous?.value ?? "azure",
  });
  protected readonly sourceLabel = computed(() => SOURCE_LABELS[this.ticketSource()]);

  public constructor() {
    effect(() => {
      const id = this.ticket();
      const repos = this.repos();
      if (this.prefilled || !id || repos.length === 0) {
        return;
      }
      const repo = this.repo();
      if (repo && repos.some((candidate) => candidate.name === repo) && this.selectedRepos()[0] !== repo) {
        this.selectedRepos.set([repo]);
        return;
      }
      // The source follows the repo's provider: wait for it so it does not overwrite the requested one.
      if (this.repoProvider.isLoading()) {
        return;
      }
      this.prefilled = true;
      const source = this.source();
      untracked(() => {
        if (source === "azure" || source === "github") {
          this.setSource(source);
        }
        this.ticketId.set(id);
        void this.loadTicket();
      });
    });
  }

  protected setSource(source: TicketSource): void {
    if (source !== this.ticketSource()) {
      this.ticketSource.set(source);
      this.loadedTicket.set(null);
      this.ticketError.set(null);
    }
  }

  protected readonly selectedTaskCount = computed(() => this.tasks().filter((task) => task.selected).length);
  protected readonly canSubmit = computed(
    () => this.ticketText().trim().length > 0 && this.selectedRepos().length > 0 && !this.submitting(),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected setAgent(event: Event): void {
    const agent = this.value(event) as AgentKind;
    this.agent.set(agent);
    this.model.set(modelsFor(agent, this.agentInfo.hasValue() ? this.agentInfo.value() : undefined)[0] ?? AGENT_MODELS[agent][0]!);
  }

  /** Fills the ticket text and the tasks (child work items or sub-issues) from Azure DevOps or GitHub. No tokens. */
  protected async loadTicket(): Promise<void> {
    const id = this.ticketId().trim().replace(/^#/, "");
    if (!id) {
      return;
    }
    this.loadingTicket.set(true);
    this.ticketError.set(null);
    try {
      const { ticket, text } = await this.api.loadTicket(this.ticketSource(), id, this.selectedRepos()[0]);
      this.loadedTicket.set(ticket);
      this.ticketText.set(text);
      this.tasks.set(
        ticket.children.map((child, index) => ({
          id: `t${index + 1}`,
          title: `#${child.id} ${child.title}`,
          selected: !child.done,
          done: child.done,
        })),
      );
    } catch (error: unknown) {
      this.loadedTicket.set(null);
      this.ticketError.set(apiError(error, this.ticketSource() === "github" ? "No se pudo cargar el issue" : "No se pudo cargar el work item"));
    } finally {
      this.loadingTicket.set(false);
    }
  }

  protected async pickTicket(id: number): Promise<void> {
    this.pickerOpen.set(false);
    this.ticketId.set(String(id));
    await this.loadTicket();
  }

  protected toggleRepo(name: string): void {
    this.selectedRepos.update((repos) => (repos.includes(name) ? repos.filter((repo) => repo !== name) : [...repos, name]));
  }

  protected addTask(): void {
    const title = this.newTask().trim();
    if (!title) {
      return;
    }
    this.tasks.update((tasks) => [...tasks, this.task(title, tasks.length)]);
    this.newTask.set("");
  }

  /** Turns the bullet/numbered lines of the ticket into tasks. */
  protected extractTasks(): void {
    const titles = this.ticketText()
      .split(/\r?\n/)
      .map((line) => BULLET.exec(line)?.[1]?.trim())
      .filter((title): title is string => Boolean(title));
    this.tasks.update((tasks) => {
      const existing = new Set(tasks.map((task) => task.title));
      const added = titles.filter((title) => !existing.has(title));
      return [...tasks, ...added.map((title, index) => this.task(title, tasks.length + index))];
    });
  }

  protected toggleTask(id: string): void {
    this.tasks.update((tasks) => tasks.map((task) => (task.id === id ? { ...task, selected: !task.selected } : task)));
  }

  protected removeTask(id: string): void {
    this.tasks.update((tasks) => tasks.filter((task) => task.id !== id));
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) {
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    const ticketId = this.ticketId().trim().replace(/^#/, "") || undefined;
    const loaded = this.loadedTicket();
    try {
      const run = await this.api.startRun({
        ticketId,
        ticketSource: this.ticketSource(),
        // A GitHub issue number only means something next to its repo.
        ticketProject: loaded?.source === "github" && String(loaded.id) === ticketId ? loaded.project : undefined,
        ticketText: this.ticketText().trim(),
        repos: this.selectedRepos(),
        tasks: this.tasks(),
        prompt: this.prompt().trim(),
        profile: this.profile() === SINGLE_AGENT ? BASE_PROFILE : this.profile(),
        ...(this.profile() === SINGLE_AGENT ? { modelConfig: { agent: this.agent(), model: this.model(), effort: this.effort() } } : {}),
        stepByStep: this.stepByStep(),
        release: this.createPr() ? "pr" : "local",
      });
      this.store.upsertRun(run);
      this.store.openTab(run.id);
      await this.router.navigate(["/runs", run.id]);
    } catch (error: unknown) {
      this.error.set(apiError(error, "No se pudo lanzar el flujo"));
    } finally {
      this.submitting.set(false);
    }
  }

  private task(title: string, index: number): TaskItem {
    return { id: `t${index + 1}`, title, selected: true, done: false };
  }

  private enabledCount(profile: FlowProfile): number {
    return Object.values(profile.steps).filter((step) => step?.enabled).length;
  }

  private toCard(profile: FlowProfile): ProfileCard {
    const steps = this.store.config()?.steps ?? [];
    return {
      name: profile.name,
      title: profile.name.charAt(0).toUpperCase() + profile.name.slice(1),
      description: profile.description,
      maxLoops: profile.maxLoops,
      steps: orderSteps(steps)
        .filter((definition) => profile.steps[definition.name]?.enabled)
        .map((definition) => ({
          label: stepLabel(definition.name),
          detail: definition.kind === "builtin" ? "sin LLM" : modelDetail(profile.steps[definition.name]!),
        })),
    };
  }
}
