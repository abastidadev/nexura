import { Component, computed, inject, linkedSignal, signal } from "@angular/core";
import type { Effort, FlowProfile, ModelAlias, StepConfig, StepName } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { STEP_LABELS } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { EFFORTS, MODELS } from "../run-view/step-inspector";

const DEFAULT_STEP: StepConfig = { model: "sonnet", effort: "medium", enabled: false };

type Row = { name: StepName; label: string; builtin: boolean; onDemand: boolean; config: StepConfig };

@Component({
  selector: "nx-profiles-editor",
  templateUrl: "./profiles-editor.html",
  host: { class: "grid min-h-0 grid-cols-[220px_minmax(0,1fr)] gap-6" },
})
export class ProfilesEditor {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly models = MODELS;
  protected readonly efforts = EFFORTS;
  protected readonly profiles = computed(() => this.store.config()?.profiles ?? []);
  protected readonly selected = linkedSignal(() => this.profiles()[0]?.name ?? "");
  /** Editable copy; `isNew` while it has not been saved yet. */
  protected readonly draft = linkedSignal<FlowProfile | null>(() => {
    const profile = this.profiles().find((candidate) => candidate.name === this.selected());
    return profile ? structuredClone(profile) : null;
  });
  protected readonly isNew = linkedSignal({ source: this.selected, computation: () => false });
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly busy = signal(false);

  /** Every step with a definition except classify (it only runs in "auto"). */
  protected readonly rows = computed<Row[]>(() => {
    const draft = this.draft();
    const steps = this.store.config()?.steps ?? [];
    return steps
      .filter((step) => step.name !== "classify")
      .map((step) => ({
        name: step.name,
        label: STEP_LABELS[step.name] ?? step.name,
        builtin: step.kind === "builtin",
        onDemand: step.name === "addressReview",
        config: draft?.steps[step.name] ?? DEFAULT_STEP,
      }));
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  /** Selects a profile and resets the draft (also used to discard an unsaved copy). */
  protected select(name: string): void {
    this.message.set(null);
    this.selected.set(name);
    this.isNew.set(false);
    const profile = this.profiles().find((candidate) => candidate.name === name);
    this.draft.set(profile ? structuredClone(profile) : null);
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

  protected setModel(name: StepName, event: Event): void {
    this.patchStep(name, { model: this.value(event) as ModelAlias });
  }

  protected setEffort(name: StepName, event: Event): void {
    this.patchStep(name, { effort: this.value(event) as Effort });
  }

  protected duplicate(): void {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.draft.set({ ...structuredClone(draft), name: `${draft.name}-copia`, description: draft.description });
    this.isNew.set(true);
    this.message.set(null);
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    if (this.isNew() && this.profiles().some((profile) => profile.name === draft.name)) {
      this.message.set({ ok: false, text: `Ya existe un perfil llamado ${draft.name}` });
      return;
    }
    await this.run(async () => {
      await this.api.saveProfile(draft);
      await this.store.reloadConfig();
      this.selected.set(draft.name);
      return `Perfil ${draft.name} guardado en config/profiles/${draft.name}.json`;
    });
  }

  protected async remove(): Promise<void> {
    const name = this.draft()?.name;
    if (!name || !confirm(`¿Borrar el perfil ${name}?`)) {
      return;
    }
    await this.run(async () => {
      await this.api.deleteProfile(name);
      await this.store.reloadConfig();
      this.selected.set(this.profiles()[0]?.name ?? "");
      return `Perfil ${name} borrado`;
    });
  }

  private async run(action: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      this.message.set({ ok: true, text: await action() });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar") });
    } finally {
      this.busy.set(false);
    }
  }
}
