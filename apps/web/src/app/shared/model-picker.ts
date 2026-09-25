import { booleanAttribute, Component, computed, input, linkedSignal, output } from "@angular/core";

const OTHER = "__other__";

/**
 * Model of an agent: a select with every suggestion (a datalist would only show the ones
 * matching what is already typed), plus "Otro…" to type any id the CLI accepts.
 */
@Component({
  selector: "nx-model-picker",
  template: `
    @if (typing()) {
      <span class="inline-flex items-center gap-1">
        <input
          class="rounded border border-border px-1.5 font-mono"
          [class]="dense() ? 'w-36 bg-surface py-0.5' : 'w-40 bg-surface-2 py-1'"
          spellcheck="false"
          placeholder="id del modelo"
          [attr.aria-label]="label()"
          [value]="value()"
          (change)="pick($any($event.target).value.trim())"
        />
        <button type="button" class="text-[11px] text-muted hover:text-fg" title="Elegir de la lista" (click)="typing.set(false)">lista</button>
      </span>
    } @else {
      <select
        class="max-w-48 rounded border border-border px-1.5 font-mono"
        [class]="dense() ? 'bg-surface py-0.5' : 'bg-surface-2 py-1'"
        [attr.aria-label]="label()"
        (change)="choose($any($event.target).value)"
      >
        @for (model of options(); track model) {
          <option [value]="model" [selected]="model === value()">{{ model }}</option>
        }
        <option [value]="other">Otro…</option>
      </select>
    }
  `,
})
export class ModelPicker {
  public readonly models = input.required<readonly string[]>();
  public readonly value = input.required<string>();
  public readonly label = input("Modelo");
  /** Smaller control (step inspector). */
  public readonly dense = input(false, { transform: booleanAttribute });
  public readonly valueChange = output<string>();

  protected readonly other = OTHER;
  /** The current value always shows up, even when it is not a suggestion. */
  protected readonly options = computed(() => (!this.value() || this.models().includes(this.value()) ? this.models() : [this.value(), ...this.models()]));
  protected readonly typing = linkedSignal({ source: this.models, computation: () => false });

  protected choose(model: string): void {
    if (model === OTHER) {
      this.typing.set(true);
    } else {
      this.pick(model);
    }
  }

  protected pick(model: string): void {
    if (model && model !== this.value()) {
      this.valueChange.emit(model);
    }
  }
}
