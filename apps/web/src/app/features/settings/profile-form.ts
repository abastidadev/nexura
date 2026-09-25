import { Component, computed, inject, input, linkedSignal, resource, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { AGENT_KINDS, AGENT_LABELS, agentOf, modelsFor, orderSteps, type AgentKind, type Effort, type FlowProfile, type StepConfig, type StepName } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { ModelPicker } from "../../shared/model-picker";
import { EFFORTS } from "../run-view/step-inspector";

const DEFAULT_STEP: StepConfig = { model: "sonnet", effort: "medium", enabled: false };
const PROFILE_NAME = /^[a-z0-9-]+$/;

/** Starting point of a blank profile: the cheap core (enrich → implement → QA → release). */
const BLANK_PROFILE: FlowProfile = {
  name: "",
  description: "",
  maxLoops: 1,
  reviewMode: "single",
  steps: {
    enrich: { model: "haiku", effort: "medium", enabled: true },
    plan: { model: "sonnet", effort: "medium", enabled: false },
    implement: { model: "sonnet", effort: "medium", enabled: true },
    codeReview: { model: "sonnet", effort: "medium", enabled: false },
    qaCode: { model: "haiku", effort: "low", enabled: true },
    release: { model: "haiku", effort: "low", enabled: true },
    qaNotes: { model: "haiku", effort: "low", enabled: false },
  },
};

type Row = { name: StepName; label: string; builtin: boolean; custom: boolean; onDemand: boolean; config: StepConfig };

/** Create/edit screen of one profile (`?tab=profiles&edit=<name>`, `&create=1[&from=<name>]`). */
@Component({
  selector: "nx-profile-form",
  imports: [RouterLink, ModelPicker],
  templateUrl: "./profile-form.html",
  host: { class: "flex flex-col gap-4" },
})
export class ProfileForm {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);
  private readonly router = inject(Router);

  /** Profile being edited; undefined when creating one. */
  public readonly name = input<string | undefined>();
  /** When creating: profile to copy from. */
  public readonly from = input<string | undefined>();

  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly agentOf = agentOf;
  /** Installed CLIs, to warn when a step uses one that is missing (and the models they report). */
  private readonly agentInfo = resource({ loader: () => this.api.getAgents() });
  protected readonly agentModels = computed(() => {
    const list = this.agentInfo.hasValue() ? this.agentInfo.value() : undefined;
    return Object.fromEntries(AGENT_KINDS.map((kind) => [kind, modelsFor(kind, list)])) as Record<AgentKind, readonly string[]>;
  });
  protected readonly missingAgents = computed(() => {
    const list = this.agentInfo.hasValue() ? this.agentInfo.value() : [];
    return new Map(list.filter((info) => !info.available).map((info) => [info.agent, info.error ?? "No instalado"]));
  });
  protected readonly efforts = EFFORTS;
  private readonly profiles = computed(() => this.store.config()?.profiles ?? []);
  protected readonly isNew = computed(() => !this.name());
  private readonly initial = computed<FlowProfile | undefined>(() => {
    if (this.name()) {
      return this.profiles().find((profile) => profile.name === this.name());
    }
    const source = this.profiles().find((profile) => profile.name === this.from());
    return source ? { ...structuredClone(source), name: `${source.name}-copia` } : structuredClone(BLANK_PROFILE);
  });
  protected readonly notFound = computed(() => !this.isNew() && this.store.config() !== null && !this.initial());
  protected readonly draft = linkedSignal<FlowProfile | undefined>(() => (this.initial() ? structuredClone(this.initial()) : undefined));
  protected readonly dirty = computed(() => this.isNew() || JSON.stringify(this.draft()) !== JSON.stringify(this.initial()));
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly busy = signal(false);

  /** Every step with a definition except classify (it only runs in "auto"). */
  protected readonly rows = computed<Row[]>(() => {
    const draft = this.draft();
    return orderSteps(this.store.config()?.steps ?? [])
      .filter((step) => step.name !== "classify")
      .map((step) => ({
        name: step.name,
        label: stepLabel(step.name),
        builtin: step.kind === "builtin",
        custom: Boolean(step.custom),
        onDemand: step.name === "addressReview",
        config: draft?.steps[step.name] ?? DEFAULT_STEP,
      }));
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  protected patch(changes: Partial<FlowProfile>): void {
    this.draft.update((draft) => (draft ? { ...draft, ...changes } : draft));
  }

  protected patchStep(name: StepName, changes: Partial<StepConfig>): void {
    this.draft.update((draft) => {
      if (!draft) {
        return draft;
      }
      const current = draft.steps[name] ?? DEFAULT_STEP;
      return { ...draft, steps: { ...draft.steps, [name]: { ...current, ...changes } } };
    });
  }

  protected setReviewMode(event: Event): void {
    this.patch({ reviewMode: this.value(event) === "blind" ? "blind" : "single" });
  }

  /** Empty = no limit. */
  protected setBudget(text: string): void {
    const value = Number(text);
    this.draft.update((draft) => {
      if (!draft) {
        return draft;
      }
      const { budgetUsd: _budget, ...rest } = draft;
      return text.trim() && Number.isFinite(value) ? { ...rest, budgetUsd: value } : rest;
    });
  }

  /** Another agent: its default model (the previous one would not exist there). */
  protected setAgent(name: StepName, event: Event): void {
    const agent = this.value(event) as AgentKind;
    this.patchStep(name, { agent, model: this.agentModels()[agent][0]! });
  }

  protected setModel(name: StepName, model: string): void {
    this.patchStep(name, { model });
  }

  // ---- judge B of the blind review: "same as codeReview" or its own agent/model/effort
  protected setJudgeBAgent(event: Event): void {
    const value = this.value(event);
    this.draft.update((draft) => {
      if (!draft) {
        return draft;
      }
      const { judgeB: _judgeB, ...rest } = draft;
      if (value === "same") {
        return rest;
      }
      const agent = value as AgentKind;
      const effort = draft.judgeB?.effort ?? draft.steps.codeReview?.effort ?? "medium";
      return { ...rest, judgeB: { agent, model: this.agentModels()[agent][0]!, effort } };
    });
  }

  protected patchJudgeB(changes: { model?: string; effort?: Effort }): void {
    this.draft.update((draft) => (draft?.judgeB ? { ...draft, judgeB: { ...draft.judgeB, ...changes } } : draft));
  }

  protected setEffort(name: StepName, event: Event): void {
    this.patchStep(name, { effort: this.value(event) as Effort });
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    const name = draft.name.trim();
    if (!PROFILE_NAME.test(name) || name === "auto") {
      this.message.set({ ok: false, text: 'Nombre no válido: usa minúsculas, números y guiones ("auto" está reservado)' });
      return;
    }
    if (this.isNew() && this.profiles().some((profile) => profile.name === name)) {
      this.message.set({ ok: false, text: `Ya existe un perfil llamado ${name}` });
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.api.saveProfile({ ...draft, name });
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "profiles" } });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar el perfil") });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const name = this.name();
    if (!name || !confirm(`¿Borrar el perfil ${name}?`)) {
      return;
    }
    this.busy.set(true);
    try {
      await this.api.deleteProfile(name);
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "profiles" } });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo borrar el perfil") });
    } finally {
      this.busy.set(false);
    }
  }
}
