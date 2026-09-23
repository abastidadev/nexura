import { Component, computed, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { orderSteps } from "@nexura/shared";
import { stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

const MS_PER_MINUTE = 60_000;
const ON_DEMAND: Record<string, string> = { classify: "modo Automático", addressReview: "a mano, desde la PR" };

@Component({
  selector: "nx-steps-list",
  imports: [RouterLink],
  template: `
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p class="max-w-3xl text-muted">
        Qué hace cada paso, en el orden en que corren: su plantilla de prompt, las herramientas que puede usar Claude y el timeout. Qué pasos corre cada flujo,
        con qué modelo y esfuerzo, se decide en los perfiles. Puedes añadir pasos propios entre los de Nexura.
      </p>
      <a
        class="shrink-0 rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90"
        routerLink="/config"
        [queryParams]="{ tab: 'steps', create: 1 }"
      >
        + Nuevo paso
      </a>
    </div>
    <div class="overflow-hidden rounded-lg border border-border bg-surface">
      <table class="w-full border-collapse text-left">
        <thead class="border-b border-border text-[11px] tracking-wide text-muted uppercase">
          <tr>
            <th class="px-4 py-2 font-medium">Paso</th>
            <th class="px-4 py-2 font-medium">Tipo</th>
            <th class="px-4 py-2 font-medium">Herramientas</th>
            <th class="px-4 py-2 font-medium">Timeout</th>
            <th class="px-4 py-2 font-medium">Lo usan</th>
            <th class="px-4 py-2"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.name) {
            <tr class="border-b border-border last:border-b-0 hover:bg-surface-2">
              <td class="px-4 py-2.5">
                <a class="font-medium hover:text-accent hover:underline" routerLink="/config" [queryParams]="{ tab: 'steps', step: row.name }">{{ row.label }}</a>
                <span class="ml-2 font-mono text-[11px] text-muted">{{ row.name }}</span>
                @if (row.custom) {
                  <span class="ml-1 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted uppercase" [attr.title]="row.description">propio</span>
                }
              </td>
              <td class="px-4 py-2.5 text-[12px] text-fg-soft">{{ row.builtin ? "sin LLM" : "claude" }}</td>
              <td class="max-w-[280px] truncate px-4 py-2.5 font-mono text-[12px] text-fg-soft" [attr.title]="row.tools">{{ row.tools }}</td>
              <td class="px-4 py-2.5 font-mono text-[12px]">{{ row.timeout }}</td>
              <td class="px-4 py-2.5 text-[12px] text-fg-soft">{{ row.usedBy }}</td>
              <td class="px-4 py-2.5 text-right">
                <a
                  class="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-surface-3"
                  routerLink="/config"
                  [queryParams]="{ tab: 'steps', step: row.name }"
                  >Editar</a
                >
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  host: { class: "block" },
})
export class StepsList {
  private readonly store = inject(NexuraStore);

  protected readonly rows = computed(() => {
    const config = this.store.config();
    const profiles = config?.profiles ?? [];
    return orderSteps(config?.steps ?? []).map((step) => ({
      name: step.name,
      label: stepLabel(step.name),
      custom: Boolean(step.custom),
      description: step.description ?? "",
      builtin: step.kind === "builtin",
      tools: step.kind === "builtin" ? "—" : step.tools.join(", ") || "ninguna",
      timeout: `${Math.round(step.timeoutMs / MS_PER_MINUTE)} min`,
      usedBy:
        ON_DEMAND[step.name] ??
        (profiles
          .filter((profile) => profile.steps[step.name]?.enabled)
          .map((profile) => profile.name)
          .join(", ") ||
          "ningún perfil"),
    }));
  });
}
