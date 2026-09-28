import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { AchievementTier } from "@nexura/shared";

/** Metal of each tier: rim light → rim dark, then the face. The same in both themes, like real medals. */
const METALS: Record<AchievementTier, { rim: [string, string]; face: [string, string]; glow: string }> = {
  bronze: { rim: ["#f0b27a", "#8a4b1f"], face: ["#d99058", "#a45a28"], glow: "rgb(217 144 88 / 0.55)" },
  silver: { rim: ["#ffffff", "#8894a6"], face: ["#e3e8f0", "#9da8b8"], glow: "rgb(200 210 225 / 0.55)" },
  gold: { rim: ["#fff1a8", "#b07a0c"], face: ["#ffd75e", "#d19a13"], glow: "rgb(255 201 64 / 0.6)" },
  platinum: { rim: ["#f4fbff", "#6f8fb8"], face: ["#d9ecff", "#a5c0e6"], glow: "rgb(160 200 255 / 0.7)" },
};

/** Points of the star-shaped rim of gold and platinum medals, as an SVG polygon. */
function burst(points: number, outer: number, inner: number): string {
  return Array.from({ length: points * 2 }, (_, index) => {
    const radius = index % 2 ? inner : outer;
    const angle = (Math.PI * index) / points - Math.PI / 2;
    return `${(32 + radius * Math.cos(angle)).toFixed(2)},${(32 + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
}

let medalSeq = 0;

/**
 * A medal: the tier's metal around the achievement's emoji. Locked ones go grey with a padlock;
 * `glow` adds the halo of a just-won one.
 */
@Component({
  selector: "nx-achievement-medal",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="relative inline-flex shrink-0 items-center justify-center" [style.width.px]="size()" [style.height.px]="size()">
      @if (glow() && !locked()) {
        <span class="nx-medal-glow absolute inset-0 rounded-full" [style.box-shadow]="'0 0 ' + size() / 3 + 'px ' + metal().glow" aria-hidden="true"></span>
      }
      <svg viewBox="0 0 64 64" class="absolute inset-0 size-full" [class.grayscale]="locked()" [class.opacity-45]="locked()" aria-hidden="true">
        <defs>
          <linearGradient [attr.id]="id + '-rim'" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" [attr.stop-color]="metal().rim[0]" />
            <stop offset="1" [attr.stop-color]="metal().rim[1]" />
          </linearGradient>
          <radialGradient [attr.id]="id + '-face'" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" [attr.stop-color]="metal().face[0]" />
            <stop offset="1" [attr.stop-color]="metal().face[1]" />
          </radialGradient>
        </defs>
        @if (starred()) {
          <polygon [attr.points]="rimPoints" [attr.fill]="'url(#' + id + '-rim)'" />
        } @else {
          <circle cx="32" cy="32" r="30" [attr.fill]="'url(#' + id + '-rim)'" />
        }
        <circle cx="32" cy="32" r="23.5" fill="rgb(0 0 0 / 0.18)" />
        <circle cx="32" cy="32" r="22" [attr.fill]="'url(#' + id + '-face)'" />
        <path d="M14 26a19 19 0 0 1 30-12" fill="none" stroke="rgb(255 255 255 / 0.55)" stroke-width="2.2" stroke-linecap="round" />
      </svg>
      <span class="relative leading-none select-none" [class.grayscale]="locked()" [class.opacity-40]="locked()" [style.font-size.px]="size() * 0.38" aria-hidden="true">{{ icon() }}</span>
      @if (locked()) {
        <span class="absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full bg-surface-3 text-muted ring-2 ring-surface" [style.width.px]="size() * 0.36" [style.height.px]="size() * 0.36" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" [style.width.px]="size() * 0.2" [style.height.px]="size() * 0.2">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
      }
    </span>
  `,
  host: { class: "inline-flex" },
})
export class AchievementMedal {
  public readonly tier = input.required<AchievementTier>();
  public readonly icon = input.required<string>();
  public readonly locked = input(false);
  public readonly glow = input(false);
  public readonly size = input(56);

  protected readonly id = `nx-medal-${++medalSeq}`;
  protected readonly rimPoints = burst(16, 31, 27.5);
  protected readonly metal = computed(() => METALS[this.tier()]);
  protected readonly starred = computed(() => this.tier() === "gold" || this.tier() === "platinum");
}
