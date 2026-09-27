import { afterRenderEffect, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from "@angular/core";
import { ACTIVITY_LABELS, type AgentNode } from "../../core/agents";
import { elapsedMs, formatDuration } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { modelFamily, type ModelFamily } from "./looks";
import { officeMembers, planOffice, type Member, type OfficeTeam } from "./office-plan";
import { OfficeRenderer, readTheme, type Hit } from "./office-renderer";

/** From this width the art is drawn at 3× instead of 2× (unless it has to fit a height). */
const WIDE_PX = 1000;
/** CSS pixels per art pixel tried when fitting a height, largest first. */
const MAX_UNIT = 4;
const MIN_UNIT = 2;

const CLOTHES: Record<ModelFamily, string> = {
  haiku: "camiseta",
  sonnet: "sudadera o camisa",
  opus: "traje",
  gpt: "camisa verde",
  gemini: "sudadera azul",
  other: "ropa de calle",
};

/**
 * Pixel-art office shared by every flow: each live flow gets a pod of desks (rug, chairs and
 * name plate in its colour) and its agents work there; whoever has nothing to do wanders
 * around the lounge, the kitchen and the games room.
 */
@Component({
  selector: "nx-pixel-office",
  template: `
    <div class="relative mx-auto" [style.width.px]="view().width" [style.height.px]="view().height">
      <canvas
        #canvas
        class="absolute top-0 left-0 block"
        [class.cursor-pointer]="hovered()"
        [style.width.px]="view().width"
        [style.height.px]="view().height"
        aria-hidden="true"
        (mousemove)="hover($event)"
        (mouseleave)="hovered.set(null)"
        (click)="click($event)"
      ></canvas>
      @if (tooltip(); as tip) {
        <div
          class="pointer-events-none absolute z-20 w-56 rounded-md border border-border bg-surface p-2 text-[11px] shadow-lg"
          [style.left.px]="tip.x"
          [style.top.px]="tip.y"
          role="tooltip"
        >
          <div class="flex items-center gap-1.5 font-semibold">
            <span class="inline-block size-2 shrink-0 rounded-full" [style.background]="tip.color"></span>
            <span class="truncate">{{ tip.label }}</span>
          </div>
          <div class="truncate text-muted">{{ tip.team }}</div>
          <div class="text-muted">{{ tip.kind }}{{ tip.model ? " · " + tip.model : "" }}</div>
          <div class="mt-1">{{ tip.activity }}</div>
          @if (tip.bubble) {
            <div class="truncate font-mono text-fg-soft">{{ tip.bubble }}</div>
          }
          <div class="mt-1 flex gap-3 font-mono text-muted">
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
      @for (member of members(); track member.key) {
        <li>
          <button type="button" (click)="select.emit(member.node)" (focus)="focused.set(member.key)" (blur)="focused.set(null)">
            {{ member.sub ? "Subagente " : "" }}{{ member.node.label }} ({{ teamTitle(member) }}): {{ activityLabel(member.node) }}{{ member.node.bubble ? " · " + member.node.bubble : "" }}
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

  public readonly teams = input.required<readonly OfficeTeam[]>();
  /** Step run or agent to mark with an arrow. */
  public readonly selectedId = input<string | undefined>();
  /** Flow to highlight (the others are dimmed). */
  public readonly focusTeam = input<string | null>(null);
  public readonly label = input("Agentes");
  /** Pick the largest zoom whose office fits the host's height (the host must get its height from outside). */
  public readonly fit = input(false);
  public readonly select = output<AgentNode>();
  public readonly selectTeam = output<string>();

  protected readonly hovered = signal<Hit | null>(null);
  protected readonly focused = signal<string | null>(null);
  private readonly containerWidth = signal(0);
  private readonly containerHeight = signal(0);
  private readonly dpr = signal(window.devicePixelRatio || 1);

  /** Device pixels per art pixel (integer, so the art stays crisp) and CSS px per art pixel. */
  private readonly layout = computed(() => {
    const dpr = this.dpr();
    const width = this.containerWidth();
    const height = this.containerHeight();
    const plan = (pixel: number) => ({ pixel, unit: pixel / dpr, plan: planOffice(this.teams(), this.members(), Math.floor(width / (pixel / dpr))) });
    if (this.fit() && height > 0) {
      // A smaller zoom also means a wider (and so shorter) office: try from the largest down.
      const min = Math.max(1, Math.round(MIN_UNIT * dpr));
      for (let pixel = Math.round(MAX_UNIT * dpr); pixel > min; pixel--) {
        const candidate = plan(pixel);
        if (candidate.plan.height * candidate.unit <= height) {
          return candidate;
        }
      }
      return plan(min);
    }
    return plan(Math.max(1, Math.round((width >= WIDE_PX ? 3 : 2) * dpr)));
  });

  private readonly scale = computed(() => ({ pixel: this.layout().pixel, unit: this.layout().unit }));

  protected readonly members = computed(() => officeMembers(this.teams()));

  private readonly plan = computed(() => this.layout().plan);

  protected readonly view = computed(() => {
    const { unit } = this.scale();
    const plan = this.plan();
    return { width: Math.round(plan.width * unit), height: Math.round(plan.height * unit) };
  });

  protected readonly tooltip = computed(() => {
    const hit = this.hovered();
    if (hit?.kind !== "agent") {
      return null;
    }
    const member = this.members().find((candidate) => candidate.key === hit.member.key) ?? hit.member;
    const node = member.node;
    const { unit } = this.scale();
    const width = this.view().width;
    const x = Math.min(Math.max(0, Math.round((hit.x + 10) * unit)), Math.max(0, width - 228));
    const family = modelFamily(node.model);
    return {
      x,
      y: Math.round((hit.y + 4) * unit),
      label: node.label,
      team: this.teamTitle(member),
      color: member.color,
      kind: node.builtin ? "Robot · paso sin LLM" : member.sub ? "Subagente" : node.kind === "planned" ? "Paso pendiente" : `Paso · va de ${CLOTHES[family]}`,
      model: node.model,
      activity: this.activityLabel(node),
      bubble: node.bubble,
      duration: node.startedAt ? formatDuration(elapsedMs(node.startedAt, node.finishedAt, this.store.now())) : "",
      turns: node.numTurns ?? 0,
    };
  });

  public constructor() {
    const destroyRef = inject(DestroyRef);
    const element = this.host.nativeElement;
    const resize = new ResizeObserver(([entry]) => {
      this.containerWidth.set(Math.floor(entry!.contentRect.width));
      this.containerHeight.set(Math.floor(entry!.contentRect.height));
    });
    resize.observe(element);
    const visibility = new IntersectionObserver(([entry]) => this.renderer?.setVisible(entry!.isIntersecting));
    visibility.observe(element);
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
      resize.disconnect();
      visibility.disconnect();
      motion.removeEventListener("change", onMotion);
      dprMedia.removeEventListener("change", onDpr);
      this.renderer?.stop();
    });

    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      renderer.setScene(this.plan(), this.members(), this.scale().pixel, this.dpr());
    });
    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      renderer.setAnimated(!reduced());
    });
    afterRenderEffect(() => {
      this.store.theme();
      const renderer = this.ensureRenderer();
      // The theme class is toggled by another effect: read the variables once it is applied.
      requestAnimationFrame(() => renderer.setTheme(readTheme(element)));
    });
    afterRenderEffect(() => {
      const renderer = this.ensureRenderer();
      const hovered = this.hovered();
      renderer.highlight(this.focused() ?? (hovered?.kind === "agent" ? hovered.member.key : null));
    });
    afterRenderEffect(() => this.ensureRenderer().select(this.selectedId()));
    afterRenderEffect(() => this.ensureRenderer().focus(this.focusTeam()));
  }

  protected activityLabel(node: AgentNode): string {
    return node.kind === "planned" && node.activity === "waiting" ? "Pendiente" : ACTIVITY_LABELS[node.activity];
  }

  protected teamTitle(member: Member): string {
    return this.teams().find((team) => team.id === member.teamId)?.title ?? "";
  }

  protected hover(event: MouseEvent): void {
    const hit = this.hitAt(event) ?? null;
    const current = this.hovered();
    const same =
      hit?.kind === current?.kind &&
      (hit?.kind === "agent" ? hit.member.key === (current as typeof hit).member.key : hit?.kind === "team" ? hit.teamId === (current as typeof hit).teamId : true);
    if (!same) {
      this.hovered.set(hit);
    }
  }

  protected click(event: MouseEvent): void {
    const hit = this.hitAt(event);
    if (hit?.kind === "agent") {
      this.select.emit(hit.member.node);
    } else if (hit?.kind === "team") {
      this.selectTeam.emit(hit.teamId);
    }
  }

  private hitAt(event: MouseEvent): Hit | undefined {
    const { unit } = this.scale();
    return this.renderer?.hitTest(event.offsetX / unit, event.offsetY / unit);
  }

  private ensureRenderer(): OfficeRenderer {
    this.renderer ??= new OfficeRenderer(this.canvas().nativeElement);
    return this.renderer;
  }
}
