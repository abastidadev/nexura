import { booleanAttribute, Component, computed, effect, type ElementRef, input, linkedSignal, output, viewChild } from "@angular/core";

const OTHER = "__other__";

/**
 * Model of an agent: a select with every suggestion (a datalist would only show the ones
 * matching what is already typed), plus "Otro…" to type any id the CLI accepts. The select
 * stays visible while typing, so picking a suggestion again closes the input.
 */
@Component({
  selector: "nx-model-picker",
  template: `
    <span class="inline-flex items-center gap-1">
      <select
        class="max-w-48 rounded border border-border px-1.5 font-mono"
        [class]="dense() ? 'bg-surface py-0.5' : 'bg-surface-2 py-1'"
        [attr.aria-label]="label()"
        (change)="choose($any($event.target).value)"
      >
        @for (model of options(); track model) {
          <option [value]="model" [selected]="!typing() && model === value()">{{ model }}</option>
        }
        <option [value]="other" [selected]="typing()">Otro…</option>
      </select>
      @if (typing()) {
        <input
          #custom
          class="rounded border border-border px-1.5 font-mono"
          [class]="dense() ? 'w-36 bg-surface py-0.5' : 'w-40 bg-surface-2 py-1'"
          spellcheck="false"
          placeholder="id del modelo"
          [attr.aria-label]="label() + ' (otro)'"
          (change)="type($any($event.target).value.trim())"
          (keydown.escape)="typing.set(false)"
        />
      }
    </span>
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
  private readonly custom = viewChild<ElementRef<HTMLInputElement>>("custom");

  public constructor() {
    effect(() => this.custom()?.nativeElement.focus());
  }

  protected choose(model: string): void {
    if (model === OTHER) {
      this.typing.set(true);
    } else {
      this.typing.set(false);
      this.pick(model);
    }
  }

  /** A typed id becomes an option of the select, so the input closes once it is set. */
  protected type(model: string): void {
    if (model) {
      this.typing.set(false);
      this.pick(model);
    }
  }

  private pick(model: string): void {
    if (model !== this.value()) {
      this.valueChange.emit(model);
    }
  }
}
