import { Component, computed, input } from "@angular/core";
import { TONE_CLASSES, type Tone } from "../core/format";

@Component({
  selector: "nx-status-pill",
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      [class]="classes().bg + ' ' + classes().text"
    >
      <span class="size-1.5 rounded-full" [class]="classes().dot" [class.nx-pulse]="live()" aria-hidden="true"></span>
      {{ label() }}
    </span>
  `,
})
export class StatusPill {
  public readonly tone = input.required<Tone>();
  public readonly label = input.required<string>();
  public readonly live = input(false);

  protected readonly classes = computed(() => TONE_CLASSES[this.tone()]);
}
