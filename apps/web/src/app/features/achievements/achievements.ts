import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, resource, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  ACHIEVEMENT_CATEGORY_LABELS,
  ACHIEVEMENT_LEVEL_POINTS,
  ACHIEVEMENT_TIER_LABELS,
  ACHIEVEMENT_TIER_POINTS,
  OFFICE_DUCKS,
  type AchievementCategory,
  type AchievementsSummary,
  type AchievementTier,
  type AchievementView,
} from "@nexura/shared";
import { Api } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";
import { AchievementMedal } from "../../shared/achievement-medal";

type CategoryFilter = AchievementCategory | "all";
type StateFilter = "all" | "won" | "pending";

const CATEGORIES: AchievementCategory[] = ["tickets", "reviews", "constancy", "office", "legend"];
const TIERS: AchievementTier[] = ["bronze", "silver", "gold", "platinum"];

/** Chip of each tier on the cards. */
const TIER_CHIP: Record<AchievementTier, string> = {
  bronze: "bg-[#d99058]/15 text-[#b8733c] ring-[#d99058]/30",
  silver: "bg-[#9da8b8]/15 text-fg-soft ring-[#9da8b8]/35",
  gold: "bg-[#ffc940]/15 text-[#b8860b] ring-[#ffc940]/35",
  platinum: "bg-[#a0c8ff]/15 text-[#4d7fbf] ring-[#a0c8ff]/40",
};

/** The progress bar of each tier. */
const TIER_BAR: Record<AchievementTier, string> = {
  bronze: "bg-[#d99058]",
  silver: "bg-[#aab5c5]",
  gold: "bg-[#f5b82e]",
  platinum: "bg-[#7fb0f0]",
};

/**
 * Logros: every trophy with its medal, how far along it is and, for the secret ones, only a
 * hint until they are won. Opening the page marks the new ones as seen.
 */
@Component({
  selector: "nx-achievements",
  imports: [AchievementMedal, DatePipe, RouterLink],
  templateUrl: "./achievements.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block h-full overflow-y-auto" },
})
export class AchievementsPage {
  private readonly api = inject(Api);
  protected readonly store = inject(NexuraStore);

  protected readonly categories = CATEGORIES;
  protected readonly tiers = TIERS;
  protected readonly categoryLabels = ACHIEVEMENT_CATEGORY_LABELS;
  protected readonly tierLabels = ACHIEVEMENT_TIER_LABELS;
  protected readonly tierPoints = ACHIEVEMENT_TIER_POINTS;
  protected readonly tierChip = TIER_CHIP;
  protected readonly tierBar = TIER_BAR;
  protected readonly totalDucks = OFFICE_DUCKS;

  protected readonly category = signal<CategoryFilter>("all");
  protected readonly state = signal<StateFilter>("all");

  private readonly data = resource({
    params: () => ({ version: this.store.achievementsVersion() }),
    loader: () => this.api.getAchievements(),
  });
  protected readonly summary = computed<AchievementsSummary | undefined>(() => (this.data.hasValue() ? this.data.value() : undefined));
  protected readonly loadError = computed(() => Boolean(this.data.error()));

  /** Won since the user last looked: highlighted while the page stays open. */
  protected readonly fresh = signal<ReadonlySet<string>>(new Set());

  protected readonly level = computed(() => {
    const points = this.summary()?.points ?? 0;
    return { level: Math.floor(points / ACHIEVEMENT_LEVEL_POINTS) + 1, into: points % ACHIEVEMENT_LEVEL_POINTS, step: ACHIEVEMENT_LEVEL_POINTS };
  });
  protected readonly completion = computed(() => {
    const summary = this.summary();
    return summary?.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
  });
  /** Circumference of the level ring (r = 42). */
  protected readonly ring = 2 * Math.PI * 42;

  protected readonly recent = computed(() =>
    (this.summary()?.achievements ?? [])
      .filter((achievement) => achievement.unlockedAt)
      .sort((a, b) => b.unlockedAt!.localeCompare(a.unlockedAt!))
      .slice(0, 4),
  );

  /** What the filters leave, grouped by category (only the chosen one when filtering). */
  protected readonly groups = computed(() => {
    const all = this.summary()?.achievements ?? [];
    const state = this.state();
    const matches = (achievement: AchievementView): boolean =>
      state === "all" || (state === "won" ? Boolean(achievement.unlockedAt) : !achievement.unlockedAt);
    const chosen = this.category();
    return CATEGORIES.filter((category) => chosen === "all" || chosen === category)
      .map((category) => {
        const items = all.filter((achievement) => achievement.category === category);
        return { category, won: items.filter((item) => item.unlockedAt).length, total: items.length, items: items.filter(matches) };
      })
      .filter((group) => group.items.length);
  });

  /** Ducks show once the first one is found: before that they would give the secret away. */
  protected readonly ducks = computed(() => {
    const found = this.summary()?.ducks ?? [];
    return found.length ? found.length : null;
  });

  public constructor() {
    // The first load says what is new; the server forgets it right away, the page keeps it.
    effect(() => {
      const summary = this.summary();
      if (!summary) {
        return;
      }
      const fresh = summary.achievements.filter((achievement) => achievement.fresh).map((achievement) => achievement.id);
      if (fresh.length) {
        this.fresh.update((current) => new Set([...current, ...fresh]));
        void this.store.markAchievementsSeen();
      } else if (this.store.freshAchievements()) {
        void this.store.markAchievementsSeen();
      }
    });
  }

  protected percent(achievement: AchievementView): number {
    const progress = achievement.progress;
    if (!progress) {
      return 0;
    }
    const parts = [progress.current / progress.goal, ...(progress.extra ? [progress.extra.current / progress.extra.goal] : [])];
    return Math.round((parts.reduce((sum, part) => sum + Math.min(1, part), 0) / parts.length) * 100);
  }

  protected countIn(category: CategoryFilter): string {
    const all = this.summary()?.achievements ?? [];
    const items = category === "all" ? all : all.filter((achievement) => achievement.category === category);
    return `${items.filter((item) => item.unlockedAt).length}/${items.length}`;
  }
}
