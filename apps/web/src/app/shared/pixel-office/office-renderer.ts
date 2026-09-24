import type { AgentActivity, AgentNode } from "../../core/agents";
import { ICONS, PERSON_FRAMES, personPalette, ROBOT_FRAMES, ROBOT_PALETTE, SPRITE_H, SPRITE_W, spriteCanvas, type FrameName, type IconName, type Palette } from "./sprites";

// All sizes are in logical (art) pixels; the canvas scales them by an integer factor.
const WALL_H = 16;
const PAD = 4;
const ZONE_GAP = 4;
const ZONE_PAD = 3;
const ZONE_TITLE_H = 10;
const CELL_GAP = 2;
const FLOOR_CELL = { w: 26, h: 44 };
const DESK_CELL = { w: 42, h: 54 };
const TABLE_W = 24;
const TILE = 8;
const FPS = 8;
const WALK_SPEED = 42;
const CHEER_MS = 2500;

export type ZoneKey = "waiting" | "office" | "done";

export type ZoneBox = { key: ZoneKey; title: string; count: number; x: number; y: number; w: number; h: number };

export type Seat = "floor" | "desk" | "table";

export type Spot = {
  node: AgentNode;
  /** Sprite top-left once seated. */
  x: number;
  y: number;
  seat: Seat;
  zone: ZoneKey;
  /** Name label under the agent. */
  label: { x: number; y: number; w: number };
  parentId?: string;
};

export type OfficeLayout = { width: number; height: number; zones: ZoneBox[]; spots: Spot[] };

const ZONE_TITLES: Record<ZoneKey, string> = { waiting: "Sala de espera", office: "Oficina", done: "Hecho" };

function zoneOf(node: AgentNode): ZoneKey {
  if (node.kind === "planned" || node.activity === "waiting") {
    return "waiting";
  }
  return node.activity === "done" || node.activity === "failed" ? "done" : "office";
}

type Cell = { w: number; h: number; place: (x: number, y: number) => Spot[] };

function floorCell(node: AgentNode, zone: ZoneKey): Cell {
  return {
    ...FLOOR_CELL,
    place: (x, y) => [{ node, zone, seat: "floor", x: x + (FLOOR_CELL.w - SPRITE_W) / 2, y: y + 9, label: { x, y: y + SPRITE_H + 10, w: FLOOR_CELL.w } }],
  };
}

function deskCell(node: AgentNode, maxWidth: number): Cell {
  const perRow = Math.max(1, Math.floor((maxWidth - DESK_CELL.w) / TABLE_W));
  const count = node.children.length;
  const rows = Math.max(1, Math.ceil(count / perRow));
  return {
    w: DESK_CELL.w + TABLE_W * Math.min(count, perRow),
    h: DESK_CELL.h * rows,
    place: (x, y) => [
      { node, zone: "office", seat: "desk", x: x + 4, y: y + 10, label: { x, y: y + 43, w: DESK_CELL.w } },
      ...node.children.map((child, index): Spot => {
        const cx = x + DESK_CELL.w + (index % perRow) * TABLE_W;
        const cy = y + Math.floor(index / perRow) * DESK_CELL.h;
        return { node: child, zone: "office", seat: "table", x: cx + 4, y: cy + 14, parentId: node.id, label: { x: cx, y: cy + 43, w: TABLE_W } };
      }),
    ],
  };
}

/** Waiting room, office and "done" area laid out as boxes that wrap to the available width. */
export function layoutOffice(agents: readonly AgentNode[], width: number): OfficeLayout {
  const inner = Math.max(DESK_CELL.w, width - 2 * PAD - 2 * ZONE_PAD);
  const groups: Record<ZoneKey, Cell[]> = { waiting: [], office: [], done: [] };
  for (const node of agents) {
    const zone = zoneOf(node);
    groups[zone].push(zone === "office" ? deskCell(node, inner) : floorCell(node, zone));
  }
  const keys = (["waiting", "office", "done"] as const).filter((key) => groups[key].length);
  const zones: ZoneBox[] = [];
  const spots: Spot[] = [];
  let x = PAD;
  let y = WALL_H + PAD;
  let rowH = 0;
  for (const key of keys) {
    const cells = groups[key];
    // Lines of cells inside the zone.
    const lines: Cell[][] = [[]];
    let lineW = 0;
    for (const cell of cells) {
      if (lineW && lineW + CELL_GAP + cell.w > inner) {
        lines.push([]);
        lineW = 0;
      }
      lines.at(-1)!.push(cell);
      lineW += (lineW ? CELL_GAP : 0) + cell.w;
    }
    const contentW = Math.max(...lines.map((line) => line.reduce((sum, cell, index) => sum + cell.w + (index ? CELL_GAP : 0), 0)));
    const contentH = lines.reduce((sum, line, index) => sum + Math.max(...line.map((cell) => cell.h)) + (index ? CELL_GAP : 0), 0);
    const w = Math.max(contentW, 44) + 2 * ZONE_PAD;
    const h = ZONE_TITLE_H + contentH + ZONE_PAD;
    if (x > PAD && x + w > width - PAD) {
      x = PAD;
      y += rowH + ZONE_GAP;
      rowH = 0;
    }
    zones.push({ key, title: ZONE_TITLES[key], count: cells.length, x, y, w, h });
    let cy = y + ZONE_TITLE_H;
    for (const line of lines) {
      let cx = x + ZONE_PAD;
      for (const cell of line) {
        spots.push(...cell.place(cx, cy));
        cx += cell.w + CELL_GAP;
      }
      cy += Math.max(...line.map((cell) => cell.h)) + CELL_GAP;
    }
    x += w + ZONE_GAP;
    rowH = Math.max(rowH, h);
  }
  return { width, height: y + rowH + PAD, zones, spots };
}

export type OfficeTheme = {
  bg: string;
  wall: string;
  floorA: string;
  floorB: string;
  border: string;
  muted: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
};

export function readTheme(element: Element): OfficeTheme {
  const style = getComputedStyle(element);
  const read = (name: string): string => style.getPropertyValue(`--nx-${name}`).trim() || "#888";
  return {
    bg: read("bg"),
    wall: read("surface"),
    floorA: read("surface-2"),
    floorB: read("surface-3"),
    border: read("border-strong"),
    muted: read("muted"),
    accent: read("accent"),
    ok: read("ok"),
    warn: read("warn"),
    err: read("err"),
    info: read("info"),
  };
}

type Sprite = { x: number; y: number; flip: boolean; cheerUntil: number; activity: AgentActivity };

const DESK = "#8a5a3c";
const DESK_DARK = "#6b4329";
const CHAIR = "#454b5c";
const MONITOR = "#2b303b";

/**
 * Draws the office on a canvas and animates it (~8 fps) with requestAnimationFrame.
 * Characters walk from where they were (e.g. the waiting room) to their new place.
 */
export class OfficeRenderer {
  private readonly context: CanvasRenderingContext2D;
  private layout: OfficeLayout = { width: 0, height: 0, zones: [], spots: [] };
  private theme?: OfficeTheme;
  private readonly sprites = new Map<string, Sprite>();
  private pixel = 2;
  private frame = 0;
  private lastTick = 0;
  private lastStep = 0;
  private raf = 0;
  private animate = true;
  private highlighted: string | null = null;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d")!;
  }

  /** `pixel` = device pixels per art pixel (integer). */
  public setScene(layout: OfficeLayout, pixel: number): void {
    const now = performance.now();
    // Resizing moves every desk: snap instead of making everyone walk.
    const walk = this.animate && layout.width === this.layout.width;
    const next = new Map<string, Sprite>();
    for (const spot of layout.spots) {
      const id = spot.node.id;
      const previous =
        this.sprites.get(id) ??
        (spot.node.kind !== "subagent" ? this.sprites.get(`planned-${spot.node.step}`) : undefined) ??
        (spot.parentId ? this.sprites.get(spot.parentId) : undefined);
      const fresh = !this.sprites.has(id);
      const finished = spot.node.activity === "done" && previous && previous.activity !== "done" && !fresh;
      next.set(id, {
        // A brand-new agent with nowhere to come from just appears in place.
        x: walk && previous ? previous.x : spot.x,
        y: walk && previous ? previous.y : spot.y,
        flip: previous?.flip ?? false,
        cheerUntil: finished ? now + CHEER_MS : (previous?.cheerUntil ?? 0),
        activity: spot.node.activity,
      });
    }
    this.sprites.clear();
    next.forEach((sprite, id) => this.sprites.set(id, sprite));
    this.layout = layout;
    this.pixel = pixel;
    this.canvas.width = Math.max(1, layout.width * pixel);
    this.canvas.height = Math.max(1, layout.height * pixel);
    this.draw(now);
  }

  public setTheme(theme: OfficeTheme): void {
    this.theme = theme;
    this.draw(performance.now());
  }

  public setAnimated(animate: boolean): void {
    this.animate = animate;
    if (!animate) {
      this.stop();
      for (const spot of this.layout.spots) {
        const sprite = this.sprites.get(spot.node.id);
        if (sprite) {
          sprite.x = spot.x;
          sprite.y = spot.y;
        }
      }
      this.draw(performance.now());
    } else {
      this.start();
    }
  }

  public highlight(id: string | null): void {
    this.highlighted = id;
    this.draw(performance.now());
  }

  public start(): void {
    if (this.raf || !this.animate) {
      return;
    }
    const loop = (time: number): void => {
      this.raf = requestAnimationFrame(loop);
      this.tick(time);
    };
    this.raf = requestAnimationFrame(loop);
  }

  public stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Agent under an art-pixel position. */
  public hitTest(x: number, y: number): Spot | undefined {
    return this.layout.spots.findLast((spot) => x >= spot.x - 2 && x < spot.x + SPRITE_W + 2 && y >= spot.y && y < spot.y + SPRITE_H + 8);
  }

  private tick(time: number): void {
    const elapsed = this.lastStep ? Math.min(100, time - this.lastStep) : 0;
    this.lastStep = time;
    let moving = false;
    for (const spot of this.layout.spots) {
      const sprite = this.sprites.get(spot.node.id);
      if (!sprite) {
        continue;
      }
      const dx = spot.x - sprite.x;
      const dy = spot.y - sprite.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) {
        const step = Math.min(distance, (WALK_SPEED * elapsed) / 1000);
        sprite.x += (dx / distance) * step;
        sprite.y += (dy / distance) * step;
        if (Math.abs(dx) > 0.5) {
          sprite.flip = dx < 0;
        }
        moving = true;
      } else {
        sprite.x = spot.x;
        sprite.y = spot.y;
      }
    }
    if (moving || time - this.lastTick >= 1000 / FPS) {
      if (time - this.lastTick >= 1000 / FPS) {
        this.frame++;
        this.lastTick = time;
      }
      this.draw(time);
    }
  }

  private draw(now: number): void {
    const theme = this.theme;
    const ctx = this.context;
    if (!theme) {
      return;
    }
    ctx.setTransform(this.pixel, 0, 0, this.pixel, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const { width, height } = this.layout;
    this.drawRoom(theme, width, height);
    for (const zone of this.layout.zones) {
      this.drawZone(theme, zone);
    }
    this.drawLinks(theme);
    const walking: Spot[] = [];
    for (const spot of this.layout.spots) {
      const sprite = this.sprites.get(spot.node.id);
      if (!sprite) {
        continue;
      }
      const seated = Math.abs(sprite.x - spot.x) < 0.5 && Math.abs(sprite.y - spot.y) < 0.5;
      if (spot.seat !== "floor") {
        this.drawChair(spot);
      }
      if (seated) {
        this.drawAgent(theme, spot, sprite, now, false);
      } else {
        walking.push(spot);
      }
      if (spot.seat === "desk") {
        this.drawDesk(theme, spot);
      } else if (spot.seat === "table") {
        this.drawTable(spot);
      }
    }
    for (const spot of walking) {
      this.drawAgent(theme, spot, this.sprites.get(spot.node.id)!, now, true);
    }
  }

  private drawRoom(theme: OfficeTheme, width: number, height: number): void {
    const ctx = this.context;
    for (let y = WALL_H; y < height; y += TILE) {
      for (let x = 0; x < width; x += TILE) {
        ctx.fillStyle = (x / TILE + y / TILE) % 2 ? theme.floorA : theme.floorB;
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
    ctx.fillStyle = theme.wall;
    ctx.fillRect(0, 0, width, WALL_H);
    ctx.fillStyle = theme.border;
    ctx.fillRect(0, WALL_H - 2, width, 2);
    // Windows and a clock on the wall.
    for (let x = 12; x + 22 < width; x += 70) {
      ctx.fillStyle = theme.border;
      ctx.fillRect(x, 3, 22, 9);
      ctx.fillStyle = theme.info;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x + 1, 4, 20, 7);
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.border;
      ctx.fillRect(x + 10, 4, 1, 7);
    }
    if (width > 60) {
      ctx.fillStyle = theme.border;
      ctx.fillRect(width - 14, 4, 7, 7);
      ctx.fillStyle = theme.wall;
      ctx.fillRect(width - 13, 5, 5, 5);
      ctx.fillStyle = theme.muted;
      ctx.fillRect(width - 11, 6, 1, 2);
      ctx.fillRect(width - 11, 7, 2, 1);
    }
  }

  private drawZone(theme: OfficeTheme, zone: ZoneBox): void {
    const ctx = this.context;
    const tint = zone.key === "waiting" ? theme.info : zone.key === "done" ? theme.ok : theme.accent;
    ctx.fillStyle = tint;
    ctx.globalAlpha = zone.key === "office" ? 0.05 : 0.1;
    ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
    ctx.globalAlpha = 0.45;
    ctx.fillRect(zone.x, zone.y, zone.w, 1);
    ctx.fillRect(zone.x, zone.y + zone.h - 1, zone.w, 1);
    ctx.fillRect(zone.x, zone.y, 1, zone.h);
    ctx.fillRect(zone.x + zone.w - 1, zone.y, 1, zone.h);
    ctx.globalAlpha = 1;
    if (zone.key === "waiting") {
      // A plant in the corner.
      const x = zone.x + zone.w - 7;
      const y = zone.y + 2;
      ctx.fillStyle = theme.ok;
      ctx.fillRect(x + 1, y, 3, 3);
      ctx.fillRect(x, y + 2, 5, 2);
      ctx.fillStyle = DESK_DARK;
      ctx.fillRect(x + 1, y + 4, 3, 3);
    }
  }

  /** Dotted line from each step to the subagents it launched. */
  private drawLinks(theme: OfficeTheme): void {
    const ctx = this.context;
    ctx.fillStyle = theme.accent;
    for (const spot of this.layout.spots) {
      const parent = spot.parentId ? this.layout.spots.find((candidate) => candidate.node.id === spot.parentId) : undefined;
      if (!parent) {
        continue;
      }
      const x0 = parent.x + SPRITE_W + 2;
      const y0 = parent.y + 10;
      const x1 = spot.x + 2;
      const y1 = spot.y + 10;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i += 3) {
        const t = steps ? i / steps : 0;
        ctx.fillRect(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 1, 1);
      }
    }
  }

  private drawChair(spot: Spot): void {
    const ctx = this.context;
    ctx.fillStyle = CHAIR;
    ctx.fillRect(spot.x + 2, spot.y + 9, 12, 12);
  }

  private drawDesk(theme: OfficeTheme, spot: Spot): void {
    const ctx = this.context;
    const x = spot.x - 3;
    const y = spot.y + 16;
    ctx.fillStyle = DESK;
    ctx.fillRect(x, y, 38, 3);
    ctx.fillStyle = DESK_DARK;
    ctx.fillRect(x, y + 3, 38, 9);
    ctx.fillRect(x + 1, y + 12, 2, 4);
    ctx.fillRect(x + 35, y + 12, 2, 4);
    // Monitor seen from the side of the character.
    const mx = spot.x + 19;
    const my = spot.y + 4;
    ctx.fillStyle = MONITOR;
    ctx.fillRect(mx, my, 14, 11);
    ctx.fillRect(mx + 6, my + 11, 2, 2);
    ctx.fillRect(mx + 3, my + 12, 8, 1);
    this.drawScreen(theme, spot.node.activity, mx + 1, my + 1);
    // Keyboard.
    ctx.fillStyle = "#c8ccd4";
    ctx.fillRect(spot.x + 3, y - 1, 10, 1);
  }

  private drawScreen(theme: OfficeTheme, activity: AgentActivity, x: number, y: number): void {
    const ctx = this.context;
    const w = 12;
    const h = 9;
    const on = !["done", "failed", "waiting"].includes(activity);
    ctx.fillStyle = activity === "running" ? "#0d1117" : activity === "reading" ? "#eef0f4" : on ? "#1c2b4a" : "#151820";
    ctx.fillRect(x, y, w, h);
    if (!on) {
      return;
    }
    const shift = this.frame % 4;
    for (let line = 0; line < 4; line++) {
      const length = 3 + ((line * 5 + shift * 3) % 8);
      ctx.fillStyle = activity === "running" ? theme.ok : activity === "reading" ? "#9aa3b2" : activity === "blocked" ? theme.warn : line % 2 ? theme.accent : theme.info;
      ctx.fillRect(x + 1, y + 1 + line * 2, Math.min(length, w - 2), 1);
    }
  }

  private drawTable(spot: Spot): void {
    const ctx = this.context;
    ctx.fillStyle = DESK;
    ctx.fillRect(spot.x - 1, spot.y + 15, 18, 2);
    ctx.fillStyle = DESK_DARK;
    ctx.fillRect(spot.x - 1, spot.y + 17, 18, 5);
    ctx.fillRect(spot.x, spot.y + 22, 2, 3);
    ctx.fillRect(spot.x + 14, spot.y + 22, 2, 3);
  }

  private frameFor(activity: AgentActivity, walking: boolean, cheering: boolean): FrameName {
    const alt = this.frame % 2 === 0;
    if (walking) {
      return alt ? "walk1" : "walk2";
    }
    if (cheering) {
      return "cheer";
    }
    switch (activity) {
      case "typing":
      case "running":
        return alt ? "type1" : "type2";
      case "reading":
        return Math.floor(this.frame / 4) % 2 ? "read2" : "read1";
      case "waiting":
        return "sleep";
      case "thinking":
        return "think";
      case "failed":
        return "error";
      default:
        return "idle";
    }
  }

  private drawAgent(theme: OfficeTheme, spot: Spot, sprite: Sprite, now: number, walking: boolean): void {
    const ctx = this.context;
    const node = spot.node;
    const robot = Boolean(node.builtin);
    const cheering = sprite.cheerUntil > now && this.animate;
    const frameName = this.frameFor(node.activity, walking, cheering);
    const palette: Palette = robot ? ROBOT_PALETTE : personPalette(node.model, `${node.runId}:${node.step}`);
    const frames = robot ? ROBOT_FRAMES : PERSON_FRAMES;
    const image = spriteCanvas(frames[frameName], palette, `${robot ? "robot" : `${palette["c"]}${palette["s"]}${palette["h"]}`}:${frameName}`);
    const bob = cheering && this.frame % 2 ? -2 : 0;
    const x = Math.round(sprite.x);
    const y = Math.round(sprite.y) + bob;

    if (node.id === this.highlighted) {
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x - 2, y - 2, SPRITE_W + 4, SPRITE_H + 4);
      ctx.globalAlpha = 1;
    }
    if (!walking && spot.seat === "floor") {
      // Shadow.
      ctx.fillStyle = "#000";
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x + 3, y + SPRITE_H - 1, 10, 2);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = node.activity === "waiting" ? 0.8 : 1;
    if (sprite.flip && walking) {
      ctx.save();
      ctx.translate(x + SPRITE_W, y);
      ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(image, x, y);
    }
    ctx.globalAlpha = 1;
    if (!walking) {
      this.drawStatusIcon(theme, node.activity, x, y, cheering);
    }
  }

  private drawStatusIcon(theme: OfficeTheme, activity: AgentActivity, x: number, y: number, cheering: boolean): void {
    const ctx = this.context;
    const icon = (name: IconName, color: string, dx: number, dy: number): void => {
      ctx.fillStyle = color;
      ICONS[name].forEach((row, iy) => [...row].forEach((cell, ix) => cell === "x" && ctx.fillRect(x + dx + ix, y + dy + iy, 1, 1)));
    };
    switch (activity) {
      case "waiting": {
        const rise = this.animate ? this.frame % 6 : 0;
        icon("sleep", theme.muted, 12, -1 - Math.floor(rise / 2));
        break;
      }
      case "thinking": {
        const dots = this.animate ? this.frame % 4 : 3;
        ctx.fillStyle = theme.muted;
        for (let i = 0; i < Math.min(3, dots); i++) {
          ctx.fillRect(x + 12 + i * 3, y - 1, 2, 2);
        }
        break;
      }
      case "blocked":
        icon("pause", theme.warn, 13, -4);
        break;
      case "failed":
        icon("alert", theme.err, 14, -5);
        break;
      case "done":
        icon("check", theme.ok, 11, cheering ? -6 : -3);
        break;
      case "delegating":
        icon("arrow", theme.accent, 13, -4);
        break;
    }
  }
}
