import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { Router } from "@angular/router";
import { ACHIEVEMENT_TIER_LABELS, ACHIEVEMENT_TIER_POINTS, type AchievementTier } from "@nexura/shared";
import { NexuraStore } from "../core/nexura-store";
import { AchievementMedal } from "./achievement-medal";

/** The accent line of each tier on the dark toast. */
const TIER_TEXT: Record<AchievementTier, string> = {
  bronze: "text-[#f0b27a]",
  silver: "text-[#dfe6f0]",
  gold: "text-[#ffd75e]",
  platinum: "text-[#bfe0ff]",
};

/**
 * A trophy just won, the way a console shows it: a dark card that slides in at the top right
 * with the medal, a shine across it and a bar that runs out. Clicking it opens Logros.
 */
@Component({
  selector: "nx-trophy-toast",
  imports: [AchievementMedal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pointer-events-none fixed top-3 right-3 z-[70] w-[min(23rem,calc(100vw-1.5rem))] md:top-4 md:right-4" aria-live="polite">
      @for (trophy of current(); track trophy.id) {
        <div
          class="nx-trophy-in pointer-events-auto relative overflow-hidden rounded-2xl bg-[#0b0f18]/95 text-white shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)] ring-1 ring-white/10 backdrop-blur-md"
          role="status"
        >
          <span class="nx-trophy-shine pointer-events-none absolute inset-0" aria-hidden="true"></span>
          <button type="button" class="flex w-full items-center gap-3.5 p-3 pr-10 text-left" (click)="open()">
            <nx-achievement-medal [tier]="trophy.tier" [icon]="trophy.icon" [size]="54" [glow]="true" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-white/60 uppercase">
                <svg viewBox="0 0 24 24" class="size-3.5" fill="currentColor" aria-hidden="true"><path d="M7 3h10v2h3a1 1 0 0 1 1 1v2a5 5 0 0 1-4.6 5A5 5 0 0 1 13 15.9V18h3v3H8v-3h3v-2.1A5 5 0 0 1 7.6 13 5 5 0 0 1 3 8V6a1 1 0 0 1 1-1h3zm0 4H5v1a3 3 0 0 0 2 2.8zm10 0v3.8A3 3 0 0 0 19 8V7z" /></svg>
                Has conseguido un trofeo
              </span>
              <span class="mt-0.5 block truncate text-[15px] leading-snug font-semibold">{{ trophy.title }}</span>
              <span class="mt-0.5 flex items-center gap-2 text-xs">
                <span class="font-semibold" [class]="tierText[trophy.tier]">{{ tierLabels[trophy.tier] }}</span>
                <span class="text-white/35" aria-hidden="true">·</span>
                <span class="text-white/60 tabular-nums">+{{ points[trophy.tier] }} pts</span>
                @if (waiting()) {
                  <span class="ml-auto rounded-full bg-white/10 px-1.5 text-[10px] font-semibold text-white/70 tabular-nums">+{{ waiting() }}</span>
                }
              </span>
            </span>
          </button>
          <button type="button" class="absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white" aria-label="Cerrar aviso del trofeo" (click)="store.dismissTrophy()">
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <span class="nx-trophy-timer absolute bottom-0 left-0 h-0.5 w-full origin-left" [class]="timerColor[trophy.tier]" aria-hidden="true"></span>
        </div>
      }
    </div>
  `,
})
export class TrophyToast {
  protected readonly store = inject(NexuraStore);
  private readonly router = inject(Router);
  protected readonly tierLabels = ACHIEVEMENT_TIER_LABELS;
  protected readonly points = ACHIEVEMENT_TIER_POINTS;
  protected readonly tierText = TIER_TEXT;
  protected readonly timerColor: Record<AchievementTier, string> = {
    bronze: "bg-[#d99058]",
    silver: "bg-[#c9d2de]",
    gold: "bg-[#ffc940]",
    platinum: "bg-[#a0c8ff]",
  };

  protected readonly current = computed(() => this.store.trophies().slice(0, 1));
  /** Trophies queued behind the one on screen. */
  protected readonly waiting = computed(() => Math.max(0, this.store.trophies().length - 1));

  protected open(): void {
    this.store.dismissTrophy();
    void this.router.navigate(["/achievements"]);
  }
}
