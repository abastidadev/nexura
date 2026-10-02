import { catSprite, CAT_H, CAT_W, characterSprite, emoteSprite, FOOT_X, FOOT_Y, poseDir, SPRITE_H } from "./characters";
import { paintBackground, paintItem, paintTv, type Screen } from "./furniture";
import { TILE, type Item, type Member, type Plan } from "./office-plan";
import { hash } from "./looks";
import { OfficeSim, type Actor, type Emote } from "./office-sim";

/** Animation frames per second (poses, screens); movement is smooth at the display rate. */
const FPS = 8;
const DRAW_MS = 1000 / 30;

export type OfficeTheme = { accent: string; font: string; mono: string };

export function readTheme(element: Element): OfficeTheme {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: read("--nx-accent", "#8b7bff"),
    font: read("--font-sans", "system-ui, sans-serif"),
    mono: read("--font-mono", "ui-monospace, monospace"),
  };
}

/** What the pointer is over. */
export type Hit = { kind: "agent"; member: Member; x: number; y: number } | { kind: "team"; teamId: string } | { kind: "trophies" | "shop" };

type Drawable = { z: number; order: number; draw: () => void };

/**
 * Paints the office on a 1× art canvas (background cached), scales it onto the visible canvas
 * without smoothing, and writes the texts on top at device resolution so they stay sharp.
 */
export class OfficeRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly art = document.createElement("canvas");
  private readonly artContext: CanvasRenderingContext2D;
  private readonly background = document.createElement("canvas");
  private backgroundKey = "";
  private readonly sim = new OfficeSim();
  private plan?: Plan;
  private members: readonly Member[] = [];
  private theme: OfficeTheme = { accent: "#8b7bff", font: "system-ui", mono: "monospace" };
  private pixel = 2;
  private dpr = 1;
  private frame = 0;
  private lastFrame = 0;
  private lastUpdate = 0;
  private lastDraw = 0;
  private raf = 0;
  private animate = true;
  private visible = true;
  private highlighted: string | null = null;
  private selected: string | undefined;
  private focusTeam: string | null = null;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d")!;
    this.artContext = this.art.getContext("2d")!;
  }

  /** `pixel` = device pixels per art pixel (integer). */
  public setScene(plan: Plan, members: readonly Member[], pixel: number, dpr: number): void {
    const now = performance.now();
    this.plan = plan;
    this.members = members;
    this.pixel = pixel;
    this.dpr = dpr;
    this.sim.setScene(plan, members, now);
    if (this.art.width !== plan.width || this.art.height !== plan.height) {
      this.art.width = plan.width;
      this.art.height = plan.height;
    }
    const width = Math.max(1, plan.width * pixel);
    const height = Math.max(1, plan.height * pixel);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.draw(now);
  }

  public setTheme(theme: OfficeTheme): void {
    this.theme = theme;
    this.draw(performance.now());
  }

  public setAnimated(animate: boolean): void {
    this.animate = animate;
    this.sim.setAnimated(animate, performance.now());
    if (animate) {
      this.start();
    } else {
      this.stop();
      this.draw(performance.now());
    }
  }

  /** Pauses the loop while the office is scrolled out of view. */
  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.start();
    } else {
      this.stop();
    }
  }

  public highlight(key: string | null): void {
    this.highlighted = key;
    this.draw(performance.now());
  }

  /** A step run id or agent id to mark with an arrow. */
  public select(id: string | undefined): void {
    this.selected = id;
    this.draw(performance.now());
  }

  /** Dims every flow but this one. */
  public focus(teamId: string | null): void {
    this.focusTeam = teamId;
    this.draw(performance.now());
  }

  public start(): void {
    if (this.raf || !this.animate || !this.visible) {
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
    this.lastUpdate = 0;
  }

  /** What is under an art-pixel position: an agent (topmost first) or a flow's name plate. */
  public hitTest(x: number, y: number): Hit | undefined {
    const actors = [...this.sim.actors].sort((a, b) => b.y - a.y);
    const actor = actors.find((candidate) => x >= candidate.x - 7 && x < candidate.x + 7 && y >= candidate.y - 26 && y < candidate.y + 1);
    if (actor) {
      return { kind: "agent", member: actor.member, x: actor.x, y: actor.y - 24 };
    }
    const pod = this.plan?.pods.find((candidate) => x >= candidate.x && x < candidate.x + candidate.w && y >= candidate.y && y < candidate.y + TILE);
    if (pod) {
      return { kind: "team", teamId: pod.teamId };
    }
    const link = this.plan?.decor.find((d) => (d.kind === "trophies" || d.kind === "shop") && x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h);
    return link ? { kind: link.kind as "trophies" | "shop" } : undefined;
  }

  private tick(time: number): void {
    const dt = this.lastUpdate ? time - this.lastUpdate : 0;
    this.lastUpdate = time;
    this.sim.update(time, dt);
    if (time - this.lastFrame >= 1000 / FPS) {
      this.frame++;
      this.lastFrame = time;
    }
    if (time - this.lastDraw >= DRAW_MS) {
      this.draw(time);
    }
  }

  private draw(now: number): void {
    const plan = this.plan;
    if (!plan) {
      return;
    }
    this.lastDraw = now;
    const ctx = this.artContext;
    const clock = new Date();
    const key = `${plan.signature}|${clock.getHours()}:${clock.getMinutes()}`;
    if (key !== this.backgroundKey) {
      this.background.width = plan.width;
      this.background.height = plan.height;
      paintBackground(this.background.getContext("2d")!, plan, clock);
      this.backgroundKey = key;
    }
    ctx.drawImage(this.background, 0, 0);
    for (const decor of plan.decor) {
      if (decor.kind === "tv") {
        paintTv(ctx, decor, this.frame);
      }
    }

    const actors = this.sim.actors;
    const bySeat = new Map<string, Actor>();
    for (const actor of actors) {
      if (actor.seat) {
        bySeat.set(actor.seat.id, actor);
      }
    }
    const drawables: Drawable[] = [];
    for (const item of plan.items) {
      drawables.push({ z: item.z ?? (item.r + item.h) * TILE, order: 0, draw: () => this.drawItem(item, bySeat, now) });
    }
    for (const actor of actors) {
      drawables.push({ z: actor.y, order: 1, draw: () => this.drawActor(actor) });
    }
    const cat = this.sim.cat;
    if (cat) {
      drawables.push({
        z: cat.y,
        order: 1,
        draw: () => this.sprite(catSprite(cat.pose, this.frame), Math.round(cat.x) - CAT_W / 2, Math.round(cat.y) - CAT_H + 2, cat.dir === "left", 1),
      });
    }
    drawables.sort((a, b) => a.z - b.z || a.order - b.order);
    for (const drawable of drawables) {
      drawable.draw();
    }
    for (const actor of actors) {
      this.drawOverhead(actor);
    }
    if (cat?.emote?.kind === "zzz") {
      this.drawZzz(cat.x + 2, cat.y - 12);
    } else if (cat?.emote) {
      this.drawEmote(cat.emote.kind, cat.x, cat.y - 10);
    }

    const view = this.context;
    view.setTransform(1, 0, 0, 1, 0, 0);
    view.imageSmoothingEnabled = false;
    view.drawImage(this.art, 0, 0, plan.width * this.pixel, plan.height * this.pixel);
    this.drawTexts(plan, bySeat);
  }

  private drawItem(item: Item, bySeat: Map<string, Actor>, now: number): void {
    const plan = this.plan!;
    let screen: Screen | undefined;
    let dimmed = false;
    if (item.kind === "desk" || item.kind === "hotDesk") {
      const seat = plan.seats.find((candidate) => candidate.id === item.seat);
      const actor = item.seat ? bySeat.get(item.seat) : undefined;
      const pod = plan.pods.find((candidate) => candidate.teamId === seat?.teamId);
      dimmed = Boolean(this.focusTeam && seat?.teamId !== this.focusTeam);
      if (actor && actor.pose === "work") {
        screen = { state: "work", activity: actor.member.node.activity };
      } else if (item.kind === "desk" && pod) {
        screen = { state: "saver", color: pod.color };
      } else {
        screen = { state: "off" };
      }
    }
    let ball: number | undefined;
    if (item.kind === "pingpong") {
      const game = this.sim.games.find((candidate) => candidate.itemId === item.id && candidate.start && now < candidate.end);
      ball = game ? (now - game.start) / 650 : undefined;
    }
    const ctx = this.artContext;
    ctx.globalAlpha = dimmed ? 0.45 : 1;
    paintItem(ctx, item, { frame: this.frame, screen, busy: this.sim.using(item.id), ball });
    ctx.globalAlpha = 1;
  }

  private sprite(image: HTMLCanvasElement, x: number, y: number, flip: boolean, alpha: number): void {
    const ctx = this.artContext;
    ctx.globalAlpha = alpha;
    if (flip) {
      ctx.save();
      ctx.translate(x + image.width, y);
      ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(image, x, y);
    }
    ctx.globalAlpha = 1;
  }

  private drawActor(actor: Actor): void {
    const ctx = this.artContext;
    const x = Math.round(actor.x);
    const y = Math.round(actor.y);
    const dimmed = Boolean(this.focusTeam && actor.member.teamId !== this.focusTeam);
    const alpha = actor.alpha * (dimmed ? 0.3 : 1);
    const marked = actor.key === this.highlighted || this.isSelected(actor);
    if (!actor.seat) {
      ctx.globalAlpha = 0.22 * alpha;
      ctx.fillStyle = "#000000";
      ctx.fillRect(x - 5, y - 1, 10, 2);
      ctx.fillRect(x - 4, y - 2, 8, 4);
      ctx.globalAlpha = 1;
    }
    if (marked) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = this.theme.accent;
      ctx.fillRect(x - 7, y - 1, 14, 2);
      ctx.fillRect(x - 6, y - 2, 12, 4);
      ctx.globalAlpha = 1;
    }
    const facing = poseDir(actor.pose, actor.dir);
    // Keep the frame in step per actor so a room full of people does not move in unison.
    const frame = this.animate ? this.frame + (hash(actor.key) % 5) : 0;
    const image = characterSprite(actor.member.look, actor.pose, actor.dir, frame, actor.member.node.activity);
    this.sprite(image, x - FOOT_X, y - FOOT_Y, facing === "left", alpha);
  }

  private isSelected(actor: Actor): boolean {
    const id = this.selected;
    const node = actor.member.node;
    return Boolean(id) && (node.id === id || (!actor.member.sub && node.stepRunId === id));
  }

  /** Emotes, status bubbles, sleep z's, rain clouds and the selection arrow. */
  private drawOverhead(actor: Actor): void {
    if (this.focusTeam && actor.member.teamId !== this.focusTeam) {
      return;
    }
    const x = actor.x;
    const top = actor.y - SPRITE_H + 4;
    const activity = actor.member.node.activity;
    const working = actor.pose === "work";
    let emote: Emote | undefined = actor.emote?.kind;
    if (working) {
      emote = activity === "thinking" ? "dots" : activity === "delegating" ? "arrow" : activity === "blocked" ? (this.frame % 4 < 3 ? "bang" : undefined) : undefined;
    }
    if (emote === "zzz" || actor.pose === "sleep" || actor.pose === "nap") {
      this.drawZzz(x + 4, top + 2);
    } else if (emote === "cloud") {
      this.drawCloud(x, top - 6);
    } else if (emote) {
      this.drawEmote(emote, x, top);
    }
    if (!working && activity === "failed" && emote !== "cloud" && actor.pose !== "sleep") {
      this.drawCloud(x, top - 6);
    }
    if (this.isSelected(actor)) {
      const bounce = this.animate && this.frame % 4 < 2 ? 1 : 0;
      const ctx = this.artContext;
      ctx.fillStyle = this.theme.accent;
      const ay = top - (emote ? 18 : 6) + bounce;
      ctx.fillRect(Math.round(x) - 3, ay, 7, 1);
      ctx.fillRect(Math.round(x) - 2, ay + 1, 5, 1);
      ctx.fillRect(Math.round(x) - 1, ay + 2, 3, 1);
      ctx.fillRect(Math.round(x), ay + 3, 1, 1);
    }
  }

  private drawEmote(kind: Emote, x: number, top: number): void {
    const image = emoteSprite(kind);
    this.artContext.drawImage(image, Math.round(x) - 2, Math.round(top) - image.height);
  }

  private drawZzz(x: number, y: number): void {
    const ctx = this.artContext;
    const rise = this.animate ? this.frame % 12 : 4;
    ctx.fillStyle = "#e8ecf8";
    const z = (zx: number, zy: number, size: number): void => {
      ctx.fillRect(zx, zy, size, 1);
      ctx.fillRect(zx + size - 2, zy + 1, 1, 1);
      if (size > 3) {
        ctx.fillRect(zx + 1, zy + 2, 1, 1);
      }
      ctx.fillRect(zx, zy + size - 1, size, 1);
    };
    const bx = Math.round(x);
    const by = Math.round(y);
    z(bx, by - Math.floor(rise / 3), 3);
    if (rise > 4) {
      z(bx + 3, by - 5 - Math.floor(rise / 3), 4);
    }
  }

  private drawCloud(x: number, y: number): void {
    const ctx = this.artContext;
    const cx = Math.round(x) - 5;
    const cy = Math.round(y) - 4;
    ctx.fillStyle = "#8a90a0";
    ctx.fillRect(cx + 2, cy, 5, 2);
    ctx.fillRect(cx, cy + 2, 10, 3);
    ctx.fillStyle = "#a8aebc";
    ctx.fillRect(cx + 3, cy, 3, 1);
    ctx.fillStyle = "#5fb8e8";
    const drop = this.animate ? this.frame % 3 : 0;
    ctx.fillRect(cx + 2, cy + 6 + drop, 1, 1);
    ctx.fillRect(cx + 5, cy + 7 + ((drop + 1) % 3), 1, 1);
    ctx.fillRect(cx + 8, cy + 6 + ((drop + 2) % 3), 1, 1);
  }

  // ── Texts at device resolution ──────────────────────────────────────────

  private drawTexts(plan: Plan, bySeat: Map<string, Actor>): void {
    const ctx = this.context;
    const unit = this.pixel;
    const dpr = this.dpr;
    ctx.textBaseline = "middle";
    // Flow name plates.
    for (const pod of plan.pods) {
      const dimmed = this.focusTeam && pod.teamId !== this.focusTeam;
      ctx.globalAlpha = dimmed ? 0.4 : 1;
      const x = (pod.x + 3) * unit;
      const y = (pod.y + 1) * unit;
      const h = 6 * unit;
      const size = Math.min(11 * dpr, h - 2 * dpr);
      ctx.font = `600 ${size}px ${this.theme.font}`;
      const maxWidth = (pod.w - 6) * unit - 8 * dpr;
      const text = fit(ctx, pod.title, maxWidth);
      const width = Math.min(maxWidth, ctx.measureText(text).width) + 8 * dpr;
      ctx.fillStyle = pod.color;
      roundRect(ctx, x, y, width, h, 2 * dpr);
      ctx.fillStyle = "#11131b";
      ctx.fillText(text, x + 4 * dpr, y + h / 2 + 0.5 * dpr);
    }
    ctx.globalAlpha = 1;
    // Name (and, with room, current tool) under each desk.
    const twoLines = unit >= 3 * dpr;
    for (const seat of plan.seats) {
      if (seat.kind !== "desk" && seat.kind !== "hot") {
        continue;
      }
      const occupant = bySeat.get(seat.id);
      const member = seat.owner ? this.members.find((candidate) => candidate.key === seat.owner) : occupant?.member;
      if (!member) {
        continue;
      }
      const dimmed = this.focusTeam && seat.teamId !== this.focusTeam;
      ctx.globalAlpha = dimmed ? 0.35 : 1;
      const working = occupant?.member === member && occupant.pose === "work";
      const cx = seat.x * unit;
      const top = (seat.y + 1) * unit;
      const maxWidth = 30 * unit;
      const size = Math.min(10 * dpr, Math.max(8 * dpr, unit * 3));
      ctx.font = `${working ? 600 : 400} ${size}px ${this.theme.font}`;
      const name = fit(ctx, member.node.label, maxWidth);
      ctx.textAlign = "center";
      shadowText(ctx, name, cx, top + size * 0.6, working ? "#f4f6fb" : "#b8c0d0");
      if (twoLines && working && member.node.bubble) {
        ctx.font = `${Math.round(size * 0.9)}px ${this.theme.mono}`;
        shadowText(ctx, fit(ctx, member.node.bubble, maxWidth), cx, top + size * 1.7, "#9fd0ff");
      }
      ctx.textAlign = "start";
    }
    ctx.globalAlpha = 1;
    // Name of the hovered or selected agent.
    for (const actor of this.sim.actors) {
      if (actor.key !== this.highlighted && !this.isSelected(actor)) {
        continue;
      }
      if (actor.seat && (actor.seat.kind === "desk" || actor.seat.kind === "hot")) {
        continue;
      }
      const size = 10 * dpr;
      ctx.font = `600 ${size}px ${this.theme.font}`;
      const text = fit(ctx, actor.member.node.label, 140 * dpr);
      const width = ctx.measureText(text).width + 8 * dpr;
      const x = Math.max(0, Math.min(plan.width * unit - width, actor.x * unit - width / 2));
      const y = (actor.y + 2) * unit;
      ctx.fillStyle = "rgba(17, 19, 27, 0.85)";
      roundRect(ctx, x, y, width, size + 4 * dpr, 3 * dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x + 4 * dpr, y + (size + 4 * dpr) / 2);
    }
    if (!plan.pods.length) {
      const work = plan.rooms.find((room) => room.key === "work")!;
      ctx.font = `${11 * dpr}px ${this.theme.font}`;
      ctx.textAlign = "center";
      shadowText(ctx, "Nadie trabajando ahora mismo", (work.c + work.w / 2) * TILE * unit, (work.r + 5) * TILE * unit, "#f0e6d8");
      ctx.textAlign = "start";
    }
  }
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) {
    end--;
  }
  return `${text.slice(0, end)}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

function shadowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.fillStyle = "rgba(10, 12, 18, 0.85)";
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

