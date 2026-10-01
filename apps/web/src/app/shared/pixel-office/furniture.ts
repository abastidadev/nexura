// Floors, walls, wall decoration and furniture painted with plain rectangles. Everything is in
// art pixels on a 1× canvas; the renderer scales the result up.
import type { AgentActivity } from "../../core/agents";
import { hash, light, shade } from "./looks";
import { FLOOR, TILE, type Decor, type Item, type Plan } from "./office-plan";

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

const WOOD = ["#a36d43", "#98643c", "#ab7449"];
const WOOD_LINE = "#7a4d2c";
const CARPET = "#3e6b9e";
const CARPET_DOT = "#4776aa";
const TILE_LIGHT = "#e4e4ea";
const TILE_DARK = "#2c2c38";
const GAMES = "#5a4a7c";
const GAMES_LINE = "#62528a";
const WALL = "#1b2032";
const WALL_EDGE = "#2a3150";
const FACE = "#2f3a5c";
const FACE_LINE = "#34406a";
const BASEBOARD = "#222a44";

const DESK_TOP = "#cf9763";
const DESK_EDGE = "#e0ab78";
const DESK_FRONT = "#9c6a40";
const DESK_DARK = "#6a4428";
const CRT = "#dcd6c6";
const CRT_SHADE = "#b4ae9e";
const SOFAS = ["#b8354f", "#3f7fa8"];

// ── Background ──────────────────────────────────────────────────────────

/** Floors, walls and wall decoration. `time` drives the window sky and the clock. */
export function paintBackground(ctx: Ctx, plan: Plan, time: Date): void {
  const { cols, rows, floor } = plan;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      paintCell(ctx, floor[r * cols + c]!, c, r, r + 1 < rows ? floor[(r + 1) * cols + c]! : FLOOR.wall);
    }
  }
  for (const decor of plan.decor.filter((candidate) => candidate.kind === "rug" || candidate.kind === "mat")) {
    paintDecor(ctx, decor, time);
  }
  for (const decor of plan.decor.filter((candidate) => candidate.kind !== "rug" && candidate.kind !== "mat")) {
    paintDecor(ctx, decor, time);
  }
}

function paintCell(ctx: Ctx, kind: number, c: number, r: number, below: number): void {
  const x = c * TILE;
  const y = r * TILE;
  switch (kind) {
    case FLOOR.wall:
      rect(ctx, x, y, TILE, TILE, WALL);
      if (below !== FLOOR.wall) {
        rect(ctx, x, y + TILE - 1, TILE, 1, WALL_EDGE);
      }
      return;
    case FLOOR.face:
      rect(ctx, x, y, TILE, TILE, FACE);
      rect(ctx, x, y + 3, TILE, 1, FACE_LINE);
      if (below !== FLOOR.face) {
        rect(ctx, x, y + TILE - 2, TILE, 2, BASEBOARD);
      }
      return;
    case FLOOR.wood:
      for (let k = 0; k < 2; k++) {
        const row = r * 2 + k;
        const offset = (row * 11) % 24;
        const py = y + k * 4;
        for (let px = x; px < x + TILE; px++) {
          const plank = Math.floor((px + offset) / 24);
          rect(ctx, px, py, 1, 3, WOOD[hash(`${row}:${plank}`) % WOOD.length]!);
          if ((px + offset) % 24 === 0) {
            rect(ctx, px, py, 1, 3, WOOD_LINE);
          }
        }
        rect(ctx, x, py + 3, TILE, 1, WOOD_LINE);
      }
      return;
    case FLOOR.carpet:
      rect(ctx, x, y, TILE, TILE, CARPET);
      rect(ctx, x + 1, y + 1, 1, 1, CARPET_DOT);
      rect(ctx, x + 5, y + 5, 1, 1, CARPET_DOT);
      return;
    case FLOOR.tiles:
      rect(ctx, x, y, TILE, TILE, (c + r) % 2 ? TILE_DARK : TILE_LIGHT);
      return;
    case FLOOR.games:
      rect(ctx, x, y, TILE, TILE, GAMES);
      rect(ctx, x + ((r * 3) % 8), y, 1, TILE, GAMES_LINE);
      return;
  }
}

function sky(time: Date): { top: string; bottom: string; night: boolean } {
  const hour = time.getHours() + time.getMinutes() / 60;
  if (hour >= 7.5 && hour < 18.5) {
    return { top: "#6fb6ee", bottom: "#b8e0f8", night: false };
  }
  if ((hour >= 18.5 && hour < 20.5) || (hour >= 6 && hour < 7.5)) {
    return { top: "#e0785a", bottom: "#f4c070", night: false };
  }
  return { top: "#0f1630", bottom: "#24305a", night: true };
}

function paintDecor(ctx: Ctx, d: Decor, time: Date): void {
  const { x, y, w, h, variant } = d;
  switch (d.kind) {
    case "rug": {
      if (variant === 2) {
        rect(ctx, x + 2, y, w - 4, h, "#c9b48a");
        rect(ctx, x, y + 2, w, h - 4, "#c9b48a");
        rect(ctx, x + 3, y + 3, w - 6, h - 6, "#b8405a");
        rect(ctx, x + 5, y + 5, w - 10, h - 10, "#d8c49a");
        return;
      }
      const color = d.color ?? "#8a7a60";
      ctx.globalAlpha = 0.22;
      rect(ctx, x, y, w, h, color);
      ctx.globalAlpha = 0.7;
      rect(ctx, x, y, w, 1, color);
      rect(ctx, x, y + h - 1, w, 1, color);
      rect(ctx, x, y, 1, h, color);
      rect(ctx, x + w - 1, y, 1, h, color);
      ctx.globalAlpha = 0.35;
      for (let px = x + 3; px < x + w - 3; px += 3) {
        rect(ctx, px, y + 2, 1, 1, color);
        rect(ctx, px, y + h - 3, 1, 1, color);
      }
      ctx.globalAlpha = 1;
      return;
    }
    case "mat":
      rect(ctx, x, y, w, h, "#6a4a30");
      for (let px = x + 1; px < x + w - 1; px += 2) {
        rect(ctx, px, y + 1, 1, h - 2, "#80603f");
      }
      return;
    case "door":
      if (variant === 0) {
        // Entrance in the bottom wall: a glass door.
        rect(ctx, x, y, w, h, "#6a4a30");
        rect(ctx, x + 1, y + 1, w - 2, h - 2, "#8fb8d0");
        rect(ctx, x + w / 2, y + 1, 1, h - 2, "#6a4a30");
        rect(ctx, x + 2, y + 2, 2, 1, "#d0e8f4");
      } else {
        // Doorway through an inner wall: posts and a lintel.
        rect(ctx, x - 1, y, 2, h, WALL_EDGE);
        rect(ctx, x + w - 1, y, 2, h, WALL_EDGE);
        rect(ctx, x - 1, y, w + 2, 2, WALL);
      }
      return;
    case "window": {
      const colors = sky(time);
      rect(ctx, x, y, w, h, "#d6cfbf");
      rect(ctx, x + 1, y + 1, w - 2, h - 3, colors.bottom);
      rect(ctx, x + 1, y + 1, w - 2, Math.floor((h - 3) / 2), colors.top);
      if (colors.night) {
        for (const [sx, sy] of [[3, 2], [9, 4], [14, 2], [w - 4, 5]] as const) {
          if (sx < w - 2) {
            rect(ctx, x + sx, y + sy, 1, 1, "#f0f0c0");
          }
        }
        rect(ctx, x + w - 6, y + 2, 3, 3, "#f0ecd0");
      } else {
        const drift = (time.getMinutes() + variant * 17) % (w + 6);
        rect(ctx, x + drift - 4, y + 3, 5, 2, "#ffffff");
        rect(ctx, x + drift - 3, y + 2, 3, 1, "#ffffff");
      }
      rect(ctx, x + Math.floor(w / 2), y + 1, 1, h - 3, "#d6cfbf");
      rect(ctx, x + 1, y + Math.floor(h / 2), w - 2, 1, "#d6cfbf");
      rect(ctx, x - 1, y + h - 2, w + 2, 2, "#bdb5a2");
      return;
    }
    case "trophies": {
      // A glass trophy case: gold, silver and bronze cups on two shelves.
      rect(ctx, x, y, w, h, "#5c3d2e");
      rect(ctx, x + 1, y + 1, w - 2, h - 2, "#1d3557");
      const cups = ["#ffc940", "#d6dde6", "#cd7f32", "#bfe0ff"];
      [y + 2, y + Math.floor(h / 2) + 1].forEach((top, level) => {
        for (let cx = x + 2, i = 0; cx < x + w - 4; cx += 5, i++) {
          const color = cups[(i + level) % cups.length]!;
          rect(ctx, cx, top + 1, 3, 2, color);
          rect(ctx, cx + 1, top + 3, 1, 1, color);
          rect(ctx, cx, top + 4, 3, 1, shade(color, 0.3));
        }
        rect(ctx, x + 1, top + 5, w - 2, 1, "#8a5a34");
      });
      rect(ctx, x + 1, y + 1, 1, h - 2, "rgba(255,255,255,0.35)");
      return;
    }
    case "shop": {
      // A shop window with a striped awning and goods on the counter.
      for (let sx = 0; sx < w; sx += 3) rect(ctx, x + sx, y, Math.min(3, w - sx), 3, sx % 6 ? "#f4f4f0" : "#e04040");
      rect(ctx, x, y + 3, w, h - 3, "#8a5a34");
      rect(ctx, x + 1, y + 4, w - 2, h - 7, "#fff3d6");
      rect(ctx, x + 3, y + 7, 3, 3, "#1b1b1b");
      rect(ctx, x + 9, y + 7, 3, 3, "#ffd640");
      rect(ctx, x + 15, y + 7, 3, 3, "#4cc9f0");
      rect(ctx, x + w - 7, y + 5, 5, 2, "#ffc940");
      return;
    }
    case "shelf": {
      rect(ctx, x, y, w, h, "#7a4a2a");
      rect(ctx, x + 1, y + 1, w - 2, h - 2, "#4a2e1a");
      const levels = [y + 1, y + Math.floor(h / 2)];
      const books = ["#c04a3a", "#3a7ac0", "#e0b040", "#4aa060", "#8a5ac0", "#e07a3a", "#f0f0f0", "#2a8a8a"];
      levels.forEach((top, level) => {
        const shelfH = Math.floor(h / 2) - 2;
        for (let bx = x + 1; bx < x + w - 2; bx += 2) {
          const seed = hash(`${variant}:${level}:${bx}`);
          if (seed % 7 === 0) {
            continue;
          }
          const bh = shelfH - (seed % 3);
          rect(ctx, bx, top + shelfH - bh, 2, bh, books[seed % books.length]!);
          rect(ctx, bx, top + shelfH - bh + 1, 2, 1, shade(books[seed % books.length]!, 0.3));
        }
        rect(ctx, x, top + shelfH, w, 1, "#8a5a34");
      });
      if (variant % 2) {
        rect(ctx, x + w - 5, y - 3, 3, 3, "#4aa04a");
        rect(ctx, x + w - 5, y - 1, 3, 1, "#b86a3a");
      }
      return;
    }
    case "clock": {
      const cx = x + 4;
      const cy = y + 4;
      rect(ctx, x + 1, y, 6, 8, "#2a2a36");
      rect(ctx, x, y + 1, 8, 6, "#2a2a36");
      rect(ctx, x + 1, y + 1, 6, 6, "#f4f4f0");
      const minute = time.getMinutes();
      const hour = (time.getHours() % 12) + minute / 60;
      const hand = (angle: number, length: number, color: string): void => {
        for (let step = 0; step <= length; step += 0.5) {
          rect(ctx, Math.round(cx - 0.5 + Math.sin(angle) * step), Math.round(cy - 0.5 - Math.cos(angle) * step), 1, 1, color);
        }
      };
      hand((minute / 60) * Math.PI * 2, 2.5, "#2a2a36");
      hand((hour / 12) * Math.PI * 2, 1.5, "#c03030");
      return;
    }
    case "whiteboard": {
      rect(ctx, x, y, w, h - 1, "#9aa0aa");
      rect(ctx, x + 1, y + 1, w - 2, h - 4, "#f6f6f8");
      const inks = ["#3a6ad0", "#d04040", "#30a060"];
      for (let line = 0; line < 3; line++) {
        const seed = hash(`${variant}:${line}`);
        rect(ctx, x + 3, y + 3 + line * 3, 4 + (seed % (w - 12)), 1, inks[line]!);
      }
      rect(ctx, x + w - 8, y + 3, 4, 4, "#f0d040");
      rect(ctx, x + 2, y + h - 2, w - 4, 1, "#7a808a");
      rect(ctx, x + 4, y + h - 3, 3, 1, "#d04040");
      return;
    }
    case "picture": {
      rect(ctx, x, y, w, h, "#b8903a");
      rect(ctx, x + 1, y + 1, w - 2, h - 2, variant ? "#e8d8b0" : "#7ab8e0");
      if (variant) {
        rect(ctx, x + 3, y + 3, 4, 3, "#6a3a2a");
        rect(ctx, x + 2, y + 6, 6, 3, "#3a5a8a");
        rect(ctx, x + 4, y + 2, 2, 2, "#e0a878");
      } else {
        rect(ctx, x + 1, y + 6, w - 2, 3, "#4a9a4a");
        rect(ctx, x + 3, y + 4, 4, 2, "#5aaa5a");
        rect(ctx, x + 6, y + 2, 2, 2, "#f8e060");
      }
      return;
    }
    case "tv":
      rect(ctx, x, y, w, h, "#18181f");
      rect(ctx, x + w / 2 - 4, y + h, 8, 1, "#18181f");
      return;
    case "dartboard":
      rect(ctx, x + 2, y, 6, 10, "#2a2a2a");
      rect(ctx, x, y + 2, 10, 6, "#2a2a2a");
      rect(ctx, x + 1, y + 1, 8, 8, "#2a2a2a");
      rect(ctx, x + 2, y + 2, 6, 6, "#e8dcb0");
      rect(ctx, x + 3, y + 3, 4, 4, "#c03030");
      rect(ctx, x + 4, y + 4, 2, 2, "#30a050");
      return;
    case "cabinets":
      if (w <= 0) {
        return;
      }
      rect(ctx, x, y, w, h, "#e8e2d4");
      rect(ctx, x, y + h - 1, w, 1, "#b8b0a0");
      for (let px = x; px < x + w; px += 12) {
        rect(ctx, px, y, 1, h, "#b8b0a0");
        rect(ctx, px + 5, y + h - 4, 2, 1, "#6a6a70");
      }
      return;
  }
}

/** The TV in the lounge: a football match that never ends. */
export function paintTv(ctx: Ctx, d: Decor, frame: number): void {
  const x = d.x + 2;
  const y = d.y + 2;
  const w = d.w - 4;
  const h = d.h - 4;
  rect(ctx, x, y, w, h, "#3a8a4a");
  rect(ctx, x + Math.floor(w / 2), y, 1, h, "#9ad0a0");
  rect(ctx, x, y, w, 1, "#9ad0a0");
  const t = frame / 3;
  const ball = { x: Math.round(x + w / 2 + Math.sin(t) * (w / 2 - 2)), y: Math.round(y + h / 2 + Math.cos(t * 1.3) * (h / 2 - 1)) };
  rect(ctx, ball.x, ball.y, 1, 1, "#ffffff");
  rect(ctx, Math.round(x + 4 + Math.sin(t * 0.7) * 3), y + 3, 1, 2, "#e04848");
  rect(ctx, Math.round(x + w - 5 + Math.cos(t * 0.8) * 3), y + 4, 1, 2, "#4a80e0");
  if (frame % 40 < 2) {
    rect(ctx, x, y, w, h, "#e8f0e8");
  }
}

// ── Furniture ───────────────────────────────────────────────────────────

export type Screen = { state: "off" } | { state: "saver"; color: string } | { state: "work"; activity: AgentActivity };

export type ItemState = { frame: number; screen?: Screen; busy?: boolean; ball?: number };

export function paintItem(ctx: Ctx, item: Item, state: ItemState): void {
  const x = item.c * TILE;
  const y = item.r * TILE;
  const w = item.w * TILE;
  const h = item.h * TILE;
  switch (item.kind) {
    case "desk":
      return paintDesk(ctx, x, y, item.variant, state);
    case "hotDesk":
      return paintHotDesk(ctx, x, y, state);
    case "chair": {
      const color = item.color ?? "#48a060";
      rect(ctx, x + 2, y, 12, 8, color);
      rect(ctx, x + 2, y, 12, 1, light(color, 0.3));
      rect(ctx, x + 2, y + 6, 12, 2, shade(color, 0.3));
      rect(ctx, x + 7, y + 8, 2, 2, "#2a2a30");
      rect(ctx, x + 3, y + 10, 10, 1, "#2a2a30");
      return;
    }
    case "stool": {
      const cx = x + w / 2;
      rect(ctx, cx - 3, y + 1, 6, 3, "#b07a4c");
      rect(ctx, cx - 3, y + 1, 6, 1, "#c89060");
      rect(ctx, cx - 1, y + 4, 2, 3, "#5a5a62");
      rect(ctx, cx - 3, y + 7, 6, 1, "#5a5a62");
      return;
    }
    case "sofaDown": {
      const base = SOFAS[item.variant % SOFAS.length]!;
      rect(ctx, x + 2, y - 5, w - 4, 11, shade(base, 0.12));
      rect(ctx, x + 2, y - 5, w - 4, 1, light(base, 0.25));
      rect(ctx, x + 2, y + 5, w - 4, 6, light(base, 0.12));
      rect(ctx, x + w / 2, y + 5, 1, 6, shade(base, 0.25));
      rect(ctx, x + 2, y + 11, w - 4, 4, shade(base, 0.3));
      rect(ctx, x, y - 2, 4, h + 1, base);
      rect(ctx, x + w - 4, y - 2, 4, h + 1, base);
      rect(ctx, x, y - 2, 4, 1, light(base, 0.3));
      rect(ctx, x + w - 4, y - 2, 4, 1, light(base, 0.3));
      return;
    }
    case "sofaUp": {
      const base = SOFAS[item.variant % SOFAS.length]!;
      rect(ctx, x + 2, y, w - 4, 6, light(base, 0.12));
      rect(ctx, x + 2, y + 6, w - 4, 9, shade(base, 0.12));
      rect(ctx, x + 2, y + 6, w - 4, 1, light(base, 0.3));
      rect(ctx, x + 2, y + 14, w - 4, 1, shade(base, 0.35));
      rect(ctx, x, y - 1, 4, h, base);
      rect(ctx, x + w - 4, y - 1, 4, h, base);
      rect(ctx, x, y - 1, 4, 1, light(base, 0.3));
      rect(ctx, x + w - 4, y - 1, 4, 1, light(base, 0.3));
      return;
    }
    case "coffeeTable":
      rect(ctx, x + 2, y + 2, w - 4, 9, "#8a5a3a");
      rect(ctx, x + 2, y + 2, w - 4, 1, "#a8744c");
      rect(ctx, x + 2, y + 11, w - 4, 2, "#5e3c26");
      rect(ctx, x + 3, y + 13, 2, 2, "#4a2e1c");
      rect(ctx, x + w - 5, y + 13, 2, 2, "#4a2e1c");
      rect(ctx, x + 7, y + 5, 3, 3, "#f0f0f0");
      rect(ctx, x + 7, y + 5, 3, 1, "#6a3a20");
      rect(ctx, x + 16, y + 4, 8, 5, "#e8d070");
      rect(ctx, x + 17, y + 5, 6, 1, "#c04a3a");
      return;
    case "plant":
      return paintPlant(ctx, x, y, item.variant);
    case "lamp":
      rect(ctx, x + 3, y - 12, 2, 18, "#3a3a42");
      rect(ctx, x + 1, y + 5, 6, 2, "#3a3a42");
      rect(ctx, x, y - 18, 8, 6, "#f0e0b0");
      rect(ctx, x, y - 13, 8, 1, "#d8c088");
      rect(ctx, x + 2, y - 12, 4, 1, "#fff4c8");
      return;
    case "counter":
      return paintCounter(ctx, x, y, item, state);
    case "fridge":
      rect(ctx, x + 1, y - 18, 14, 26, "#e8ecf0");
      rect(ctx, x + 13, y - 18, 2, 26, "#c8ced6");
      rect(ctx, x + 1, y - 8, 14, 1, "#b0b8c2");
      rect(ctx, x + 11, y - 15, 1, 5, "#8a929c");
      rect(ctx, x + 11, y - 5, 1, 7, "#8a929c");
      rect(ctx, x + 3, y - 15, 2, 2, "#e04848");
      rect(ctx, x + 6, y - 13, 2, 2, "#48a0e0");
      rect(ctx, x + 4, y - 11, 3, 2, "#f0f0a0");
      return;
    case "vending": {
      rect(ctx, x + 1, y - 20, 14, 28, "#c03040");
      rect(ctx, x + 1, y - 20, 14, 1, "#e05060");
      rect(ctx, x + 3, y - 17, 8, 15, state.busy && state.frame % 2 ? "#e8f4ff" : "#c8e0f0");
      const snacks = ["#f0c040", "#e04848", "#48a060", "#7a5ac0"];
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
          rect(ctx, x + 4 + col * 2 + (col ? col - 1 : 0), y - 16 + row * 4, 2, 2, snacks[(row + col) % snacks.length]!);
        }
      }
      rect(ctx, x + 12, y - 15, 2, 6, "#2a2a30");
      rect(ctx, x + 12, y - 14, 1, 1, state.busy ? "#50ff80" : "#80a080");
      rect(ctx, x + 3, y + 1, 8, 3, "#2a1a20");
      return;
    }
    case "cooler":
      rect(ctx, x + 1, y - 4, 6, 11, "#d8dce4");
      rect(ctx, x + 1, y - 4, 6, 1, "#eef0f4");
      rect(ctx, x + 2, y - 14, 4, 10, "#8ac8f0");
      rect(ctx, x + 1, y - 12, 6, 6, "#8ac8f0");
      rect(ctx, x + 2, y - 12, 1, 5, "#c8e8fa");
      rect(ctx, x + 2, y - 1, 1, 1, "#e04848");
      rect(ctx, x + 5, y - 1, 1, 1, "#4880e0");
      if (state.busy && state.frame % 4 < 2) {
        rect(ctx, x + 3, y - 10, 1, 1, "#ffffff");
      }
      return;
    case "roundTable":
      rect(ctx, x + 3, y + 1, 10, 10, "#c89060");
      rect(ctx, x + 1, y + 3, 14, 6, "#c89060");
      rect(ctx, x + 3, y + 1, 10, 1, "#dca878");
      rect(ctx, x + 1, y + 9, 14, 1, "#9a6a40");
      rect(ctx, x + 3, y + 10, 10, 1, "#9a6a40");
      rect(ctx, x + 7, y + 11, 2, 3, "#5a5a62");
      rect(ctx, x + 4, y + 14, 8, 1, "#5a5a62");
      if (item.variant % 2) {
        rect(ctx, x + 7, y + 2, 2, 4, "#e8e8f0");
        rect(ctx, x + 6, y, 4, 2, "#e070a8");
      } else {
        rect(ctx, x + 4, y + 4, 2, 2, "#f0f0f0");
        rect(ctx, x + 10, y + 5, 2, 2, "#f0f0f0");
      }
      return;
    case "meetingTable":
      rect(ctx, x + 1, y + 1, w - 2, 11, "#8a5a3a");
      rect(ctx, x + 1, y + 1, w - 2, 1, "#a8744c");
      rect(ctx, x + 1, y + 12, w - 2, 2, "#5e3c26");
      rect(ctx, x + 3, y + 14, 2, 2, "#4a2e1c");
      rect(ctx, x + w - 5, y + 14, 2, 2, "#4a2e1c");
      for (let px = x + 5; px < x + w - 8; px += 16) {
        rect(ctx, px, y + 3, 8, 5, "#3a3e48");
        rect(ctx, px + 1, y + 4, 6, 3, "#5a8ac0");
        rect(ctx, px + 10, y + 6, 4, 3, "#f4f4f4");
      }
      return;
    case "arcade":
      return paintArcade(ctx, x, y, item.variant, state);
    case "pingpong":
      rect(ctx, x, y + 1, w, 10, "#2f7a4a");
      rect(ctx, x, y + 1, w, 1, "#f0f0f0");
      rect(ctx, x, y + 10, w, 1, "#f0f0f0");
      rect(ctx, x, y + 1, 1, 10, "#f0f0f0");
      rect(ctx, x + w - 1, y + 1, 1, 10, "#f0f0f0");
      rect(ctx, x + 1, y + 5, w - 2, 1, "#a8d0b0");
      rect(ctx, x + w / 2 - 1, y - 1, 2, 12, "#d8d8e0");
      rect(ctx, x, y + 11, w, 2, "#1f5a34");
      rect(ctx, x + 2, y + 13, 2, 3, "#3a3a42");
      rect(ctx, x + w - 4, y + 13, 2, 3, "#3a3a42");
      if (state.ball !== undefined) {
        const t = state.ball;
        const bounce = Math.abs(Math.sin(t * Math.PI));
        rect(ctx, Math.round(x + 2 + (w - 5) * (t % 2 < 1 ? t % 1 : 1 - (t % 1))), Math.round(y + 4 - bounce * 5), 2, 2, "#fff4d0");
      }
      return;
    case "beanbag": {
      const color = ["#e0823a", "#3aa8a0"][item.variant % 2]!;
      rect(ctx, x + 2, y - 4, 12, 11, color);
      rect(ctx, x, y - 1, 16, 7, color);
      rect(ctx, x + 3, y - 4, 6, 1, light(color, 0.3));
      rect(ctx, x + 1, y + 4, 14, 3, shade(color, 0.25));
      return;
    }
    case "printer":
      rect(ctx, x + 1, y - 7, 14, 14, "#d8dae0");
      rect(ctx, x + 1, y - 7, 14, 3, "#8a8e98");
      rect(ctx, x + 3, y - 1, 10, 2, "#6a6e78");
      rect(ctx, x + 12, y - 3, 1, 1, state.busy && state.frame % 2 ? "#50ff80" : "#3a8a50");
      if (state.busy) {
        const out = state.frame % 6;
        rect(ctx, x + 4, y + 1 - out, 8, 2 + out, "#ffffff");
      } else {
        rect(ctx, x + 4, y + 1, 8, 2, "#ffffff");
      }
      return;
    case "bin":
      rect(ctx, x + 2, y, 5, 7, "#7a808c");
      rect(ctx, x + 2, y, 5, 1, "#9aa0ac");
      rect(ctx, x + 3, y - 1, 2, 2, "#f0f0f0");
      return;
  }
}

function paintPlant(ctx: Ctx, x: number, y: number, variant: number): void {
  const leaf = ["#3a8a3a", "#2e7a44", "#4a9a3a"][variant % 3]!;
  const dark = shade(leaf, 0.3);
  const lit = light(leaf, 0.25);
  if (variant === 1) {
    // Tall palm.
    for (const [dx, dy, w, h] of [
      [3, -20, 2, 12],
      [0, -16, 3, 2],
      [5, -17, 3, 2],
      [-2, -12, 4, 2],
      [6, -12, 4, 2],
      [1, -10, 2, 4],
      [5, -9, 2, 3],
    ] as const) {
      rect(ctx, x + dx, y + dy, w, h, dy < -14 ? lit : leaf);
    }
    rect(ctx, x + 3, y - 8, 2, 8, dark);
  } else if (variant === 2) {
    rect(ctx, x + 1, y - 9, 6, 9, leaf);
    rect(ctx, x, y - 7, 8, 5, leaf);
    rect(ctx, x + 2, y - 9, 2, 2, lit);
    rect(ctx, x + 5, y - 5, 2, 2, dark);
    rect(ctx, x + 1, y - 4, 2, 2, dark);
  } else {
    for (const [dx, dy, w, h] of [
      [3, -14, 2, 10],
      [0, -11, 3, 5],
      [5, -12, 3, 6],
      [1, -7, 2, 4],
      [5, -6, 2, 3],
    ] as const) {
      rect(ctx, x + dx, y + dy, w, h, leaf);
    }
    rect(ctx, x + 3, y - 14, 1, 3, lit);
    rect(ctx, x, y - 11, 1, 2, lit);
    rect(ctx, x + 6, y - 9, 1, 3, dark);
  }
  rect(ctx, x + 1, y, 6, 7, "#b86a3a");
  rect(ctx, x + 1, y, 6, 1, "#d08050");
  rect(ctx, x + 1, y + 5, 6, 2, "#8a4a2a");
}

function paintDesk(ctx: Ctx, x: number, y: number, prop: number, state: ItemState): void {
  // Top, front and legs.
  rect(ctx, x + 1, y + 8, 30, 10, DESK_TOP);
  rect(ctx, x + 1, y + 8, 30, 1, DESK_EDGE);
  rect(ctx, x + 1, y + 18, 30, 4, DESK_FRONT);
  rect(ctx, x + 2, y + 22, 2, 2, DESK_DARK);
  rect(ctx, x + 28, y + 22, 2, 2, DESK_DARK);
  rect(ctx, x + 20, y + 19, 8, 2, DESK_DARK);
  // CRT monitor.
  rect(ctx, x + 9, y, 14, 12, CRT);
  rect(ctx, x + 9, y + 11, 14, 1, CRT_SHADE);
  rect(ctx, x + 13, y + 12, 6, 2, CRT_SHADE);
  rect(ctx, x + 20, y + 10, 2, 1, "#50c060");
  paintScreen(ctx, x + 11, y + 2, 10, 7, state.screen ?? { state: "off" }, state.frame);
  // Keyboard and mouse.
  rect(ctx, x + 10, y + 14, 12, 3, "#e8e8ec");
  for (let kx = x + 11; kx < x + 21; kx += 2) {
    rect(ctx, kx, y + 15, 1, 1, "#b8b8c0");
  }
  rect(ctx, x + 24, y + 14, 2, 3, "#e8e8ec");
  switch (prop) {
    case 1:
      // Rubber duck.
      rect(ctx, x + 3, y + 12, 4, 3, "#f8d030");
      rect(ctx, x + 5, y + 10, 3, 3, "#f8d030");
      rect(ctx, x + 8, y + 11, 1, 1, "#f08020");
      rect(ctx, x + 6, y + 11, 1, 1, "#2a2a2a");
      return;
    case 2:
      rect(ctx, x + 3, y + 11, 4, 4, "#f0f0f0");
      rect(ctx, x + 3, y + 11, 4, 1, "#6a3a20");
      rect(ctx, x + 7, y + 12, 1, 2, "#f0f0f0");
      return;
    case 3:
      rect(ctx, x + 3, y + 11, 4, 4, "#b86a3a");
      rect(ctx, x + 2, y + 7, 6, 4, "#4aa04a");
      rect(ctx, x + 4, y + 5, 2, 2, "#5ab85a");
      return;
    case 4:
      rect(ctx, x + 2, y + 11, 6, 5, "#f4f4f4");
      rect(ctx, x + 3, y + 10, 6, 5, "#ffffff");
      rect(ctx, x + 4, y + 11, 4, 1, "#9aa0aa");
      rect(ctx, x + 4, y + 13, 3, 1, "#9aa0aa");
      return;
    case 5:
      rect(ctx, x + 3, y + 9, 5, 6, "#6a4a2a");
      rect(ctx, x + 4, y + 10, 3, 4, "#8ac0e8");
      rect(ctx, x + 5, y + 11, 1, 2, "#e0a878");
      return;
  }
}

function paintHotDesk(ctx: Ctx, x: number, y: number, state: ItemState): void {
  rect(ctx, x + 4, y + 12, 24, 6, "#b89070");
  rect(ctx, x + 4, y + 12, 24, 1, "#d0a888");
  rect(ctx, x + 4, y + 18, 24, 3, "#8a6a4a");
  rect(ctx, x + 5, y + 21, 2, 3, "#5a5a62");
  rect(ctx, x + 25, y + 21, 2, 3, "#5a5a62");
  // Laptop.
  rect(ctx, x + 10, y + 5, 12, 8, "#3a3e48");
  paintScreen(ctx, x + 11, y + 6, 10, 6, state.screen ?? { state: "off" }, state.frame);
  rect(ctx, x + 9, y + 13, 14, 2, "#a8acb4");
}

function paintScreen(ctx: Ctx, x: number, y: number, w: number, h: number, screen: Screen, frame: number): void {
  if (screen.state === "off") {
    rect(ctx, x, y, w, h, "#12151c");
    rect(ctx, x + 1, y + 1, 2, 1, "#262a34");
    return;
  }
  if (screen.state === "saver") {
    rect(ctx, x, y, w, h, "#0c0f1a");
    const period = (w - 2) * 2;
    const step = frame % period;
    const px = step < w - 2 ? step : period - step;
    const py = Math.floor(frame / 3) % (h - 1);
    rect(ctx, x + px, y + py, 2, 1, screen.color);
    return;
  }
  const lines = (color: string | string[], background: string, scroll: boolean): void => {
    rect(ctx, x, y, w, h, background);
    for (let line = 0; line < Math.floor(h / 2); line++) {
      const seed = hash(`${line + (scroll ? frame : Math.floor(frame / 4))}`);
      const length = 2 + (seed % (w - 3));
      rect(ctx, x + 1 + (seed % 2), y + 1 + line * 2, Math.min(length, w - 2), 1, Array.isArray(color) ? color[seed % color.length]! : color);
    }
  };
  switch (screen.activity) {
    case "typing":
      lines(["#8b7bff", "#5aa9ff", "#f0c060", "#e8e8f0"], "#1c2233", false);
      if (frame % 2) {
        rect(ctx, x + w - 3, y + h - 2, 1, 1, "#ffffff");
      }
      return;
    case "running":
      lines("#3fcf8e", "#0a0d10", true);
      return;
    case "reading":
      rect(ctx, x, y, w, h, "#e8ecf2");
      for (let line = 0; line < Math.floor(h / 2); line++) {
        const seed = hash(`read:${line + Math.floor(frame / 6)}`);
        rect(ctx, x + 1, y + 1 + line * 2, 3 + (seed % (w - 4)), 1, "#8a94a6");
      }
      return;
    case "blocked":
      rect(ctx, x, y, w, h, frame % 4 < 2 ? "#4a3510" : "#2a1e08");
      rect(ctx, x + w / 2 - 1, y + 1, 1, h - 4, "#f2b84b");
      rect(ctx, x + w / 2 - 1, y + h - 2, 1, 1, "#f2b84b");
      return;
    case "delegating":
      rect(ctx, x, y, w, h, "#1e1a33");
      for (let i = 0; i < 3; i++) {
        rect(ctx, x + 1 + i * 3, y + 2 + ((frame + i) % 2), 2, 2, "#8b7bff");
      }
      return;
    case "idle":
      lines("#e8e8f0", "#23283a", false);
      return;
    default: {
      // Thinking: a spinner.
      rect(ctx, x, y, w, h, "#16233e");
      const spots = [
        [0, -2],
        [2, 0],
        [0, 2],
        [-2, 0],
      ] as const;
      spots.forEach(([dx, dy], index) => {
        rect(ctx, x + w / 2 + dx - 1, y + Math.floor(h / 2) + dy, 1, 1, index === frame % 4 ? "#ffffff" : "#4a6aa0");
      });
      return;
    }
  }
}

function paintCounter(ctx: Ctx, x: number, y: number, item: Item, state: ItemState): void {
  rect(ctx, x, y - 4, 8, 6, "#d8d8de");
  rect(ctx, x, y - 4, 8, 1, "#eeeef2");
  rect(ctx, x, y + 2, 8, 6, "#8a94a4");
  rect(ctx, x + 3, y + 3, 2, 1, "#d8dce4");
  if (item.variant === 1) {
    rect(ctx, x, y - 4, 1, 12, "#6a7282");
  } else if (item.variant === 2) {
    rect(ctx, x + 7, y - 4, 1, 12, "#6a7282");
  } else {
    rect(ctx, x, y + 2, 1, 6, "#7a8494");
  }
  switch (item.appliance) {
    case "coffee":
      rect(ctx, x + 1, y - 13, 6, 10, "#2a2a32");
      rect(ctx, x + 1, y - 13, 6, 1, "#4a4a54");
      rect(ctx, x + 2, y - 11, 4, 2, "#c8a060");
      rect(ctx, x + 5, y - 8, 1, 1, state.busy ? "#ff5050" : "#6a3030");
      rect(ctx, x + 2, y - 5, 3, 2, "#f0f0f0");
      if (state.busy) {
        const rise = state.frame % 4;
        rect(ctx, x + 3, y - 15 - rise, 1, 2, "#ffffff");
        rect(ctx, x + 4, y - 18 - ((rise + 2) % 4), 1, 2, "#e0e0e8");
      }
      return;
    case "sink":
      rect(ctx, x + 1, y - 3, 6, 3, "#9aa4b4");
      rect(ctx, x + 2, y - 2, 4, 2, "#b8d8f0");
      rect(ctx, x + 3, y - 8, 2, 5, "#b0b8c4");
      rect(ctx, x + 3, y - 8, 3, 1, "#b0b8c4");
      if (state.busy && state.frame % 2) {
        rect(ctx, x + 5, y - 7, 1, 4, "#a8d8ff");
      }
      return;
    case "microwave":
      rect(ctx, x, y - 10, 8, 7, "#e8e8ec");
      rect(ctx, x + 1, y - 9, 5, 5, state.busy ? "#f0d070" : "#2a2e38");
      rect(ctx, x + 6, y - 9, 1, 1, state.busy ? "#50ff80" : "#3a3a42");
      return;
    case "fruit":
      rect(ctx, x + 1, y - 5, 6, 2, "#c8a878");
      rect(ctx, x + 2, y - 7, 2, 2, "#e04040");
      rect(ctx, x + 4, y - 7, 2, 2, "#f0c030");
      rect(ctx, x + 3, y - 8, 2, 2, "#60b040");
      return;
    default:
      return;
  }
}

function paintArcade(ctx: Ctx, x: number, y: number, variant: number, state: ItemState): void {
  const body = ["#6a3ac0", "#2a5ab0", "#c03a4a"][variant % 3]!;
  rect(ctx, x + 1, y - 20, 14, 28, body);
  rect(ctx, x + 1, y - 20, 14, 1, light(body, 0.3));
  rect(ctx, x + 13, y - 20, 2, 28, shade(body, 0.3));
  rect(ctx, x + 2, y - 19, 11, 3, state.frame % 8 < 4 ? "#f8d040" : "#f0a030");
  rect(ctx, x + 3, y - 15, 9, 9, "#0a0a14");
  const frame = state.frame;
  if (state.busy) {
    // Someone is playing: a ship dodging falling blocks.
    for (let i = 0; i < 3; i++) {
      const seed = hash(`${variant}:${i}:${Math.floor(frame / 8)}`);
      rect(ctx, x + 3 + (seed % 8), y - 15 + ((frame + i * 3) % 8), 1, 1, ["#ff5050", "#50ff80", "#5fb8ff"][i]!);
    }
    rect(ctx, x + 6 + Math.round(Math.sin(frame / 2) * 2), y - 8, 3, 1, "#f8f8f8");
  } else {
    // Attract mode.
    rect(ctx, x + 4, y - 12, 7, 1, frame % 6 < 3 ? "#f8d040" : "#5fb8ff");
    rect(ctx, x + 5, y - 10, 5, 1, "#8a8aa0");
  }
  rect(ctx, x + 2, y - 5, 12, 4, shade(body, 0.2));
  rect(ctx, x + 4, y - 5, 1, 2, "#2a2a2a");
  rect(ctx, x + 3, y - 6, 3, 1, "#e04040");
  rect(ctx, x + 8, y - 4, 1, 1, "#f0d040");
  rect(ctx, x + 10, y - 4, 1, 1, "#50c0ff");
  rect(ctx, x + 5, y + 2, 5, 2, "#1a1a22");
}

