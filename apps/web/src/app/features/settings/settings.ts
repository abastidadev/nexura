import { Component, computed, inject, input } from "@angular/core";
import { Router } from "@angular/router";
import { GeneralSettings } from "./general-settings";
import { MemoryBrowser } from "./memory-browser";
import { ProfileForm } from "./profile-form";
import { ProfilesList } from "./profiles-list";
import { RepoForm } from "./repo-form";
import { StepCreate } from "./step-create";
import { ReposList } from "./repos-list";
import { StepsEditor } from "./steps-editor";
import { StepsList } from "./steps-list";

export type SettingsTab = "general" | "profiles" | "steps" | "repos" | "memory";

const TABS: { id: SettingsTab; label: string; help: string }[] = [
  { id: "general", label: "General", help: "Umbral de cuota, revisión de comentarios de PR y memoria compartida." },
  { id: "profiles", label: "Perfiles", help: "Qué pasos corre cada perfil y con qué modelo y esfuerzo." },
  { id: "steps", label: "Pasos", help: "Plantilla del prompt, herramientas permitidas y timeout de cada paso." },
  { id: "repos", label: "Repos", help: "Repositorios, rama base y checks de QA." },
  { id: "memory", label: "Memoria", help: "Lo guardado en la memoria compartida (engram) de cada repo." },
];

/**
 * Each section is a list; editing or creating an item opens its own screen. The state
 * lives in the query params so the browser's back button returns to the list:
 * `?tab=repos&edit=<name>`, `?tab=repos&create=1`, `?tab=profiles&create=1&from=<name>`, `?tab=steps&step=<name>`,
 * `?tab=steps&create=1`.
 */
@Component({
  selector: "nx-settings",
  imports: [GeneralSettings, MemoryBrowser, ProfilesList, ProfileForm, StepsList, StepsEditor, StepCreate, ReposList, RepoForm],
  template: `
    <div class="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
      @switch (screen()) {
        @case ("repo-form") {
          <nx-repo-form [name]="edit()" />
        }
        @case ("profile-form") {
          <nx-profile-form [name]="edit()" [from]="from()" />
        }
        @case ("step-create") {
          <nx-step-create />
        }
        @case ("step-form") {
          <nx-steps-editor [name]="step()!" />
        }
        @default {
          <div>
            <h1 class="text-xl font-semibold tracking-tight">Configuración</h1>
            <p class="mt-1 text-muted">
              Perfiles, pasos y repos se guardan en <code class="font-mono">config/</code> del repo de Nexura (versiónalos con git); lo general y las
              notas aprendidas, en <code class="font-mono">data/</code>.
            </p>
          </div>
          <div class="flex gap-1 border-b border-border" role="tablist" aria-label="Secciones de configuración">
            @for (item of tabs; track item.id) {
              <button
                type="button"
                role="tab"
                class="-mb-px border-b-2 px-3 py-2"
                [class]="active() === item.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'"
                [attr.aria-selected]="active() === item.id"
                [attr.title]="item.help"
                (click)="open(item.id)"
              >
                {{ item.label }}
              </button>
            }
          </div>
          <div role="tabpanel">
            @switch (active()) {
              @case ("general") {
                <nx-general-settings />
              }
              @case ("profiles") {
                <nx-profiles-list />
              }
              @case ("steps") {
                <nx-steps-list />
              }
              @case ("repos") {
                <nx-repos-list />
              }
              @case ("memory") {
                <nx-memory-browser />
              }
            }
          </div>
        }
      }
    </div>
  `,
  host: { class: "block h-full overflow-y-auto" },
})
export class Settings {
  private readonly router = inject(Router);

  /** Query params (see the class comment). */
  public readonly tab = input<string | undefined>();
  public readonly step = input<string | undefined>();
  public readonly edit = input<string | undefined>();
  public readonly create = input<string | undefined>();
  public readonly from = input<string | undefined>();

  protected readonly tabs = TABS;
  protected readonly active = computed<SettingsTab>(() => {
    const tab = this.tab();
    return TABS.some((item) => item.id === tab) ? (tab as SettingsTab) : "general";
  });
  protected readonly screen = computed(() => {
    const editing = Boolean(this.edit() || this.create());
    switch (this.active()) {
      case "repos":
        return editing ? "repo-form" : "list";
      case "profiles":
        return editing ? "profile-form" : "list";
      case "steps":
        return this.step() ? "step-form" : this.create() ? "step-create" : "list";
      default:
        return "list";
    }
  });

  protected open(tab: SettingsTab): void {
    void this.router.navigate(["/config"], { queryParams: { tab } });
  }
}
