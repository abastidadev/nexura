import { afterRenderEffect, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from "@angular/core";
import { ACTIVITY_LABELS, type AgentNode } from "../../core/agents";
import { elapsedMs, formatCost, formatDuration } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { layoutOffice, OfficeRenderer, readTheme, type Spot } from "./office-renderer";

/** Below this width the art is drawn at 2× instead of 3×. */
const WIDE_PX = 560;

/**
 * Pixel-art office with one character per agent: waiting room for the planned steps,
 * desks for the ones working (subagents at small tables next to them) and a "done" area.
 */
@Component({
  selector: "nx-pixel-office",
  template: `
    <div class="relative" [style.height.px]="view().height">
      <canvas
        #canvas
        class="absolute top-0 left-0 block cursor-pointer"
        [style.width.px]="view().width"
        [style.height.px]="view().height"
        aria-hidden="true"
        (mousemove)="hover($event)"
        (mouseleave)="hovered.set(null)"
        (click)="click($event)"
      ></canvas>
      @for (zone of view().zones; track zone.key) {
        <span
          class="pointer-events-none absolute truncate text-[10px] font-semibold tracking-wide text-muted uppercase"
          [style.left.px]="zone.x + 4"
          [style.top.px]="zone.y + 2"
          [style.max-width.px]="zone.w - 8"
          aria-hidden="true"
          >{{ zone.title }} · {{ zone.count }}</span
        >
      }
      @for (item of view().labels; track item.id) {
        <span
          class="pointer-events-none absolute truncate text-center text-[10px] leading-3"
          [class]="item.working ? 'text-fg' : 'text-muted'"
          [class.font-semibold]="item.selected"
          [class.text-accent]="item.selected"
          [style.left.px]="item.x"
          [style.top.px]="item.y"
          [style.width.px]="item.w"
          aria-hidden="true"
          >{{ item.text }}</span
        >
      }
      @for (bubble of view().bubbles; track bubble.id) {
        <span
          class="pointer-events-none absolute z-10 -translate-y-full truncate rounded border px-1.5 py-px font-mono text-[10px] shadow-sm"
          [class]="bubble.tone"
          [style.left.px]="bubble.x"
          [style.top.px]="bubble.y"
          [style.max-width.px]="bubble.maxWidth"
          aria-hidden="true"
          >{{ bubble.text }}</span
        >
      }
      @if (tooltip(); as tip) {
        <div
          class="pointer-events-none absolute z-20 w-52 rounded-md border border-border bg-surface p-2 text-[11px] shadow-lg"
          [style.left.px]="tip.x"
          [style.top.px]="tip.y"
          role="tooltip"
        >
          <div class="font-semibold">{{ tip.label }}</div>
          <div class="text-muted">{{ tip.kind }}{{ tip.model ? " · " + tip.model : "" }}</div>
          <div class="mt-1">{{ tip.activity }}</div>
          @if (tip.bubble) {
            <div class="truncate font-mono text-fg-soft">{{ tip.bubble }}</div>
          }
          <div class="mt-1 flex gap-3 font-mono text-muted">
            @if (tip.cost) {
              <span>{{ tip.cost }}</span>
            }
            @if (tip.duration) {
              <span>{{ tip.duration }}</span>
            }
            @if (tip.turns) {
              <span>{{ tip.turns }} turnos</span>
            }
          </div>
        </div>
      }
    </div>
    <ul class="sr-only" [attr.aria-label]="label()">
      @for (item of flat(); track item.node.id) {
        <li>
          <button type="button" (click)="select.emit(item.node)" (focus)="focused.set(item.node.id)" (blur)="focused.set(null)">
            {{ item.child ? "Subagente " : "" }}{{ item.node.label }}: {{ activityLabel(item.node) }}{{ item.node.bubble ? " · " + item.node.bubble : "" }}
          </button>
        </li>
      }
    </ul>
  `,
  host: { class: "block" },
})
export class PixelOffice {
  private readonly store = inject(NexuraStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>("canvas");
  private renderer?: OfficeRenderer;

  public readonly agents = input.required<AgentNode[]>();
  public readonly selectedId = input<string | undefined>();
  public readonly label = input("Agentes");
  public readonly select = output<AgentNode>();

  protected readonly hovered = signal<Spot | null>(null);
  protected readonly focused = signal<string | null>(null);
  private readonly containerWidth = signal(0);
  private readonly dpr = signal(window.devicePixelRatio || 1);

  /** Device pixels per art pixel (integer, so the art stays crisp) and CSS px per art pixel. */
  private readonly scale = computed(() => {
    const css = this.containerWidth() >= WIDE_PX ? 3 : 2;
    const pixel = Math.max(1, Math.round(css * this.dpr()));
    return { pixel, unit: pixel / this.dpr() };
  });

  protected readonly layout = computed(() => {
    const { unit } = this.scale();
    return layoutOffice(this.agents(), Math.max(60, Math.floor(this.containerWidth() / unit)));
  });

  protected readonly view = computed(() => {
    const layout = this.layout();
    const { unit } = this.scale();
    const selected = this.selectedId();
    const px = (value: number): number => Math.round(value * unit);
    return {
      width: px(layout.width),
      height: px(layout.height),
      zones: layout.zones.map((zone) => ({ ...zone, x: px(zone.x), y: px(zone.y), w: px(zone.w) })),
      labels: layout.spots.map((spot) => ({
        id: spot.node.id,
        text: spot.node.label,
        working: spot.zone === "office",
        selected: spot.node.id === selected || (spot.node.stepRunId === selected && spot.node.kind !== "subagent"),
        x: px(spot.label.x),
        y: px(spot.label.y),
        w: px(spot.label.w),
      })),
      bubbles: layout.spots
        .filter((spot) => spot.node.bubble && (spot.zone === "office" || spot.node.activity === "blocked"))
        .map((spot) => ({
          id: spot.node.id,
          text: spot.node.bubble!,
          tone:
            spot.node.activity === "blocked"
              ? "border-warn bg-warn-soft text-warn backdrop-blur"
              : spot.node.activity === "failed"
                ? "border-err bg-surface text-err"
                : "border-border bg-surface text-fg-soft",
          x: Math.max(0, px(spot.x) - 4),
          y: px(spot.y - 2),
          maxWidth: Math.min(176, px(layout.width) - Math.max(0, px(spot.x) - 4)),
        })),
    };
  });

  protected readonly tooltip = computed(() => {
    const spot = this.hovered();
    if (!spot) {
      return null;
    }
    const node = spot.node;
    const { unit } = this.scale();
    const width = this.view().width;
    const x = Math.min(Math.max(0, Math.round((spot.x + 20) * unit)), Math.max(0, width - 212));
    return {
      x,
      y: Math.round((spot.y + 4) * unit),
      label: node.label,
      kind: { step: "Paso", planned: "Paso pendiente", subagent: "Subagente", builtin: "Paso sin LLM" }[node.kind],
      model: node.model,
      activity: this.activityLabel(node),
      bubble: node.bubble,
      cost: node.costUsd ? formatCost(node.costUsd) : "",
      duration: node.startedAt ? formatDuration(elapsedMs(node.startedAt, node.finishedAt, this.store.now())) : "",
      turns: node.numTurns ?? 0,
    };
  });

  protected readonly flat = computed(() =>
    this.agents().flatMap((node) => [{ node, child: false }, ...node.children.map((child) => ({ node: child, child: true }))]),
  );

  public constructor() {
    const destroyRef = inject(DestroyRef);
    const observer = new ResizeObserver(([entry]) => this.containerWidth.set(Math.floor(entry!.contentRect.width)));
    observer.observe(this.host.nativeElement);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = signal(motion.matches);
    const onMotion = (): void => reduced.set(motion.matches);
    motion.addEventListener("change", onMotion);
    const dprQuery = (): MediaQueryList => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    let dprMedia = dprQuery();
    const onDpr = (): void => {
      this.dpr.set(window.devicePixelRatio || 1);
      dprMedia.removeEventListener("change", onDpr);
      dprMedia = dprQuery();
      dprMedia.addEventListener("change", onDpr);
    };
    dprMedia.addEventListener("change", onDpr);
    destroyRef.onDestroy(() => {
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
      dprMedia.removeEventListener("change", onDpr);
      this.renderer?.stop();
    });

    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      renderer.setScene(this.layout(), this.scale().pixel);
    });
    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      renderer.setAnimated(!reduced());
    });
    afterRenderEffect(() => {
      this.store.theme();
      const renderer = this.ensureRenderer();
      // The theme class is toggled by another effect: read the variables once it is applied.
      requestAnimationFrame(() => renderer.setTheme(readTheme(this.host.nativeElement)));
    });
    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      const hovered = this.hovered()?.node.id;
      renderer.highlight(this.focused() ?? hovered ?? null);
    });
  }

  protected activityLabel(node: AgentNode): string {
    return node.kind === "planned" && node.activity === "waiting" ? "Pendiente" : ACTIVITY_LABELS[node.activity];
  }

  protected hover(event: MouseEvent): void {
    const spot = this.spotAt(event);
    if (spot?.node.id !== this.hovered()?.node.id) {
      this.hovered.set(spot ?? null);
    }
  }

  protected click(event: MouseEvent): void {
    const spot = this.spotAt(event);
    if (spot) {
      this.select.emit(spot.node);
    }
  }

  private spotAt(event: MouseEvent): Spot | undefined {
    const { unit } = this.scale();
    return this.renderer?.hitTest(event.offsetX / unit, event.offsetY / unit);
  }

  private ensureRenderer(): OfficeRenderer {
    this.renderer ??= new OfficeRenderer(this.canvas().nativeElement);
    return this.renderer;
  }
}
