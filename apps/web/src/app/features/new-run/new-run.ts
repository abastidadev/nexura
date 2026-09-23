import { Component, computed, inject, linkedSignal, signal } from "@angular/core";
import { Router } from "@angular/router";
import { orderSteps, type FlowProfile, type TaskItem, type TicketDetails } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { TicketPicker } from "./ticket-picker";

export const AUTO_PROFILE = "auto";
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;

type ProfileCard = {
  name: string;
  title: string;
  description: string;
  steps: { label: string; detail: string }[];
  maxLoops?: number;
};

@Component({
  selector: "nx-new-run",
  imports: [TicketPicker],
  templateUrl: "./new-run.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class NewRun {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  protected readonly ticketId = signal("");
  protected readonly ticketText = signal("");
  protected readonly prompt = signal("");
  protected readonly tasks = signal<TaskItem[]>([]);
  protected readonly newTask = signal("");
  protected readonly profile = signal(AUTO_PROFILE);
  protected readonly stepByStep = signal(false);
  protected readonly createPr = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  // ---- Azure DevOps work item
  protected readonly loadedTicket = signal<TicketDetails | null>(null);
  protected readonly loadingTicket = signal(false);
  protected readonly ticketError = signal<string | null>(null);
  protected readonly pickerOpen = signal(false);

  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  /** Pre-selects the only repo when there is just one. */
  protected readonly selectedRepos = linkedSignal<string[]>(() => {
    const repos = this.repos();
    return repos.length === 1 ? [repos[0]!.name] : [];
  });

  protected readonly profiles = computed<ProfileCard[]>(() => [
    {
      name: AUTO_PROFILE,
      title: "Automático",
      description: "Un paso classify (haiku, esfuerzo bajo) lee el ticket y elige el perfil.",
      steps: [{ label: stepLabel("classify"), detail: "haiku/low" }],
    },
    // Cheapest first: fewer enabled steps, then fewer loops.
    ...[...(this.store.config()?.profiles ?? [])]
      .sort((a, b) => this.enabledCount(a) - this.enabledCount(b) || a.maxLoops - b.maxLoops)
      .map((profile) => this.toCard(profile)),
  ]);

  protected readonly selectedTaskCount = computed(() => this.tasks().filter((task) => task.selected).length);
  protected readonly canSubmit = computed(
    () => this.ticketText().trim().length > 0 && this.selectedRepos().length > 0 && !this.submitting(),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** Fills the ticket text and the tasks (child work items) from Azure DevOps. No tokens. */
  protected async loadTicket(): Promise<void> {
    const id = this.ticketId().trim().replace(/^#/, "");
    if (!id) {
      return;
    }
    this.loadingTicket.set(true);
    this.ticketError.set(null);
    try {
      const { ticket, text } = await this.api.loadWorkItem(id, this.selectedRepos()[0]);
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
      this.ticketError.set(apiError(error, "No se pudo cargar el work item"));
    } finally {
      this.loadingTicket.set(false);
    }
  }

  protected async pickTicket(id: number): Promise<void> {
    this.pickerOpen.set(false);
    this.ticketId.set(String(id));
    await this.loadTicket();
  }

  /** One-line step list for the collapsed profile rows. */
  protected stepSummary(card: ProfileCard): string {
    return card.steps.map((step) => step.label).join(" · ");
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
    try {
      const run = await this.api.startRun({
        ticketId: this.ticketId().trim().replace(/^#/, "") || undefined,
        ticketText: this.ticketText().trim(),
        repos: this.selectedRepos(),
        tasks: this.tasks(),
        prompt: this.prompt().trim(),
        profile: this.profile(),
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

  private enabledCount(profile: FlowProfile): number {
    return Object.values(profile.steps).filter((step) => step?.enabled).length;
  }

  private task(title: string, index: number): TaskItem {
    return { id: `t${index + 1}`, title, selected: true, done: false };
  }

  private toCard(profile: FlowProfile): ProfileCard {
    return {
      name: profile.name,
      title: profile.name.charAt(0).toUpperCase() + profile.name.slice(1),
      description: profile.description,
      maxLoops: profile.maxLoops,
      steps: orderSteps(this.store.config()?.steps ?? [])
        .map((definition) => definition.name)
        .filter((name) => profile.steps[name]?.enabled)
        .map((name) => {
        const step = profile.steps[name]!;
        const builtin = this.store.config()?.steps.find((definition) => definition.name === name)?.kind === "builtin";
        return { label: stepLabel(name), detail: builtin ? "sin LLM" : `${step.model}/${step.effort}` };
      }),
    };
  }
}
