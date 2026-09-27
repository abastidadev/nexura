import { Component, computed, input } from "@angular/core";

/** Circle as a path, so every icon is a plain list of `d` strings. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
}

const SPEAKER = "M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z";

/** 24×24 stroke icons, one consistent weight. Decorative by default (aria-hidden). */
const ICONS = {
  flows: [circle(6, 6, 2.5), circle(6, 18, 2.5), circle(18, 7, 2.5), "M6 8.5v7", "M18 9.5c0 5-4 8.5-9.5 8.5"],
  reviews: [circle(18, 18, 2.5), circle(6, 6, 2.5), "M13 6h3a2 2 0 0 1 2 2v7.5", "M6 8.5V21", "m15 3-2 3 2 3"],
  terminal: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "m7 10 2.5 2L7 14", "M12.5 14H16"],
  agents: ["M12 8V4.5", circle(12, 3.5, 1), "M6.5 8h11A2.5 2.5 0 0 1 20 10.5v6a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-6A2.5 2.5 0 0 1 6.5 8z", "M2 13v2", "M22 13v2", "M9.5 12.5v1.5", "M14.5 12.5v1.5"],
  metrics: ["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"],
  settings: ["M20 5h-8", "M8 5H4", "M20 12h-5", "M11 12H4", "M20 19h-9", "M7 19H4", "M10 3v4", "M13 10v4", "M9 17v4"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  search: [circle(11, 11, 7), "m20 20-3.5-3.5"],
  arrowRight: ["M5 12h14", "m13 6 6 6-6 6"],
  chevronLeft: ["m15 18-6-6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  chevronDown: ["m6 9 6 6 6-6"],
  check: ["M20 6 9 17l-5-5"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  bellOff: ["M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5", "M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7", "M10.3 21a1.94 1.94 0 0 0 3.4 0", "m2 2 20 20"],
  volume: [SPEAKER, "M16 9a5 5 0 0 1 0 6", "M19.4 18.4a9 9 0 0 0 0-12.8"],
  volumeOff: [SPEAKER, "m22 9-6 6", "m16 9 6 6"],
  sun: [circle(12, 12, 4), "M12 2v2", "M12 20v2", "m4.9 4.9 1.4 1.4", "m17.7 17.7 1.4 1.4", "M2 12h2", "M20 12h2", "m6.3 17.7-1.4 1.4", "m19.1 4.9-1.4 1.4"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"],
  refresh: ["M3 12a9 9 0 0 1 15.5-6.2L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15.5 6.2L3 16", "M8 16H3v5"],
  pin: ["M12 17v5", "M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"],
  pencil: ["M21.2 6.8a2.8 2.8 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z", "m15 5 4 4"],
  play: ["M6 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 6 4.5z"],
  stop: ["M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  fork: [circle(6, 5, 2.5), circle(18, 5, 2.5), circle(12, 19, 2.5), "M6 7.5v1a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-1", "M12 11.5v5"],
  history: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 13h8", "M8 17h5"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  monitor: ["M4 3.5h16a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4"],
  sidebar: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18"],
  activity: ["M22 12h-4l-3 8L9 4l-3 8H2"],
  done: [circle(12, 12, 9.5), "m8.5 12 2.5 2.5 4.5-5"],
  coins: [circle(9, 9, 6), "M18.1 10.4A6 6 0 1 1 10.4 18.1", "M7 7h2.5v4.5"],
  alert: ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
  spark: ["M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9z", "M19 3v3", "M17.5 4.5h3"],
  clock: [circle(12, 12, 9.5), "M12 7v5l3 2"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"],
  wifiOff: [circle(12, 19, 0.6), "M8.5 16.4a5 5 0 0 1 7 0", "M2 8.8a15 15 0 0 1 4.2-2.6", "M5 12.9a10 10 0 0 1 5.2-2.7", "M22 8.8a15 15 0 0 0-11.3-3.8", "M19 12.9a10 10 0 0 0-2.1-1.5", "m2 2 20 20"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;

@Component({
  selector: "nx-icon",
  template: `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.width]="size()"
      [attr.height]="size()"
      [attr.stroke-width]="stroke()"
      aria-hidden="true"
      focusable="false"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  host: { class: "inline-flex shrink-0" },
})
export class Icon {
  public readonly name = input.required<IconName>();
  public readonly size = input(18);
  public readonly stroke = input(1.75);

  protected readonly paths = computed(() => ICONS[this.name()]);
}
