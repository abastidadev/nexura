import { Component, input, linkedSignal } from "@angular/core";
import { ProfilesEditor } from "./profiles-editor";
import { ReposEditor } from "./repos-editor";
import { StepsEditor } from "./steps-editor";

type SettingsTab = "profiles" | "steps" | "repos";

const TABS: { id: SettingsTab; label: string; help: string }[] = [
  { id: "profiles", label: "Perfiles", help: "Qué pasos corre cada perfil y con qué modelo y esfuerzo." },
  { id: "steps", label: "Pasos", help: "Plantilla del prompt, herramientas permitidas y timeout de cada paso." },
  { id: "repos", label: "Repos", help: "Repositorios, rama base y checks de QA." },
];

@Component({
  selector: "nx-settings",
  imports: [ProfilesEditor, StepsEditor, ReposEditor],
  template: `
    <div class="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Configuración</h1>
        <p class="mt-1 text-muted">Se guarda en <code class="font-mono">config/</code> del repo de Nexura: versiónala con git como cualquier otra pieza.</p>
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
            (click)="active.set(item.id)"
          >
            {{ item.label }}
          </button>
        }
      </div>
      <div role="tabpanel">
        @switch (active()) {
          @case ("profiles") {
            <nx-profiles-editor />
          }
          @case ("steps") {
            <nx-steps-editor [initialStep]="step()" />
          }
          @case ("repos") {
            <nx-repos-editor />
          }
        }
      </div>
    </div>
  `,
  host: { class: "block h-full overflow-y-auto" },
})
export class Settings {
  /** Query params: `?tab=steps&step=implement`. */
  public readonly tab = input<string | undefined>();
  public readonly step = input<string | undefined>();

  protected readonly tabs = TABS;
  protected readonly active = linkedSignal<SettingsTab>(() => {
    const tab = this.tab();
    return TABS.some((item) => item.id === tab) ? (tab as SettingsTab) : "profiles";
  });
}
