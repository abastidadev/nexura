// Life in the office: agents with work go to their desk; the rest wander around, sit on the
// sofa, fall asleep, get coffee, chat, play ping-pong or pet the cat. Pure (no DOM): the
// renderer calls `update` every frame and draws `actors`.
import { hash } from "./looks";
import { FLOOR, TILE, type Dir, type Member, type Plan, type Poi, type Seat } from "./office-plan";

export type Pose =
  | "stand"
  | "walk"
  | "work"
  | "sitBack"
  | "sitFront"
  | "sleep"
  | "nap"
  | "drink"
  | "phone"
  | "book"
  | "cheer"
  | "dance"
  | "yawn"
  | "sad"
  | "talk"
  | "reach"
  | "play"
  | "swing"
  | "pet";

export type Emote = "zzz" | "dots" | "heart" | "note" | "idea" | "question" | "bang" | "coffee" | "bug" | "happy" | "star" | "arrow" | "cloud" | "check" | "sweat";

type Chat = { id: number; a: Actor; b: Actor; start: number; end: number; cancelled: boolean };

export type Game = { id: number; a: Actor; b: Actor; left: Poi; right: Poi; itemId: string; start: number; end: number; arrived: number; cancelled: boolean };

type Step = { begun?: boolean } & (
  | { t: "walk"; cell: number }
  | { t: "glide"; x: number; y: number }
  | { t: "pose"; pose: Pose; dir?: Dir; ms: number; emote?: Emote; soft?: boolean; use?: string }
  | { t: "sit"; seat: Seat; pose?: Pose; ms: number; emote?: Emote }
  | { t: "chat"; chat: Chat; lead: boolean }
  | { t: "game"; game: Game; poi: Poi }
  | { t: "leave" }
);

export type Actor = {
  key: string;
  member: Member;
  /** Feet position in art pixels. */
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
  alpha: number;
  emote?: { kind: Emote; until: number };
  /** Seat the actor is sitting on right now. */
  seat?: Seat;
  queue: Step[];
  path: number[];
  stepStart: number;
  activity: string;
  gone: boolean;
};

export type Cat = { x: number; y: number; dir: Dir; pose: "walk" | "sit" | "sleep"; path: number[]; until: number; emote?: { kind: Emote; until: number } };

const WORKING = new Set(["thinking", "reading", "typing", "running", "delegating", "blocked", "idle"]);
const SPEED = 30;
const CAT_SPEED = 20;
const TALK_TURN_MS = 1500;
/** Cells between two people chatting: a body is two cells wide, so three leaves a gap and two just touch. */
const CHAT_DISTANCES = [3, 2];
const SETTLE_MS = 2500;
const CHAT_TOPICS: Emote[] = ["dots", "heart", "note", "idea", "question", "bang", "coffee", "bug", "happy", "star", "sweat"];

type Mood = "waiting" | "done" | "failed";

export function isWorking(activity: string): boolean {
  return WORKING.has(activity);
}

/** Standing spot inside a cell. */
export function cellPoint(plan: Plan, cell: number): { x: number; y: number } {
  return { x: (cell % plan.cols) * TILE + 4, y: Math.floor(cell / plan.cols) * TILE + 6 };
}

export function cellAt(plan: Plan, x: number, y: number): number {
  const c = Math.min(plan.cols - 1, Math.max(0, Math.floor(x / TILE)));
  const r = Math.min(plan.rows - 1, Math.max(0, Math.floor(y / TILE)));
  return r * plan.cols + c;
}

/** Breadth-first path over walkable cells; `to` may be a seat cell that others cannot cross. */
export function findPath(plan: Plan, from: number, to: number): number[] | null {
  if (from === to) {
    return [];
  }
  const { cols, walk } = plan;
  const size = walk.length;
  const previous = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  previous[from] = from;
  queue[tail++] = from;
  while (head < tail) {
    const cell = queue[head++]!;
    const c = cell % cols;
    const neighbours = [cell - cols, cell + cols, c > 0 ? cell - 1 : -1, c < cols - 1 ? cell + 1 : -1];
    for (const next of neighbours) {
      if (next < 0 || next >= size || previous[next] !== -1 || (!walk[next] && next !== to)) {
        continue;
      }
      previous[next] = cell;
      if (next === to) {
        const path = [to];
        for (let at = cell; at !== from; at = previous[at]!) {
          path.unshift(at);
        }
        return path;
      }
      queue[tail++] = next;
    }
  }
  return null;
}

/** Closest walkable cell (itself if it already is). */
export function nearestWalkable(plan: Plan, cell: number): number {
  if (plan.walk[cell]) {
    return cell;
  }
  const seen = new Uint8Array(plan.walk.length);
  const queue = [cell];
  seen[cell] = 1;
  while (queue.length) {
    const at = queue.shift()!;
    const c = at % plan.cols;
    for (const next of [at - plan.cols, at + plan.cols, c > 0 ? at - 1 : -1, c < plan.cols - 1 ? at + 1 : -1]) {
      if (next < 0 || next >= plan.walk.length || seen[next]) {
        continue;
      }
      if (plan.walk[next]) {
        return next;
      }
      seen[next] = 1;
      queue.push(next);
    }
  }
  return plan.door;
}

export class OfficeSim {
  private plan?: Plan;
  private readonly actorMap = new Map<string, Actor>();
  private readonly departed = new Set<string>();
  private readonly seatTaken = new Map<string, string>();
  private readonly poiTaken = new Map<string, string>();
  private readonly hotSeats = new Map<string, string>();
  private readonly gameList: Game[] = [];
  private readonly inUse = new Set<string>();
  private leisureCells: number[] = [];
  private deskOf = new Map<string, Seat>();
  private ids = 0;
  /** When the first agents showed up: whoever arrives with the initial data is placed, not walked in. */
  private firstSeen?: number;
  private animate = true;
  public cat?: Cat;

  public constructor(private readonly random: () => number = Math.random) {}

  public get actors(): readonly Actor[] {
    return [...this.actorMap.values()];
  }

  public get games(): readonly Game[] {
    return this.gameList;
  }

  public actor(key: string): Actor | undefined {
    return this.actorMap.get(key);
  }

  /** Item ids being used right now (coffee machine brewing, arcade being played…). */
  public using(itemId: string): boolean {
    return this.inUse.has(itemId);
  }

  public setAnimated(animate: boolean, now: number): void {
    if (this.animate === animate) {
      return;
    }
    this.animate = animate;
    if (this.plan) {
      this.reset(now);
    }
  }

  /** New plan and/or members. Keeps everyone in place while the plan's signature does not change. */
  public setScene(plan: Plan, members: readonly Member[], now: number): void {
    const previous = this.plan;
    const changed = previous?.signature !== plan.signature;
    this.plan = plan;
    if (changed) {
      this.deskOf = new Map(plan.seats.filter((seat) => seat.owner).map((seat) => [seat.owner!, seat]));
      this.leisureCells = this.computeLeisureCells(plan);
    }
    const keys = new Set(members.map((member) => member.key));
    for (const [key, actor] of this.actorMap) {
      if (!keys.has(key)) {
        this.drop(actor);
      }
    }
    if (changed && previous) {
      if (previous.cols !== plan.cols || previous.rows !== plan.rows || !this.animate) {
        this.reset(now);
      } else {
        this.seatTaken.clear();
        this.poiTaken.clear();
        this.hotSeats.clear();
        for (const actor of this.actorMap.values()) {
          const desk = this.workSeat(actor);
          const seated = desk && actor.seat && Math.hypot(actor.x - desk.x, actor.y - desk.y) < 0.5;
          actor.seat = undefined;
          this.clear(actor);
          if (seated) {
            // Its desk did not move: keep working.
            this.sitNow(actor, desk, Infinity, "work", now);
            continue;
          }
          const cell = cellAt(plan, actor.x, actor.y);
          const walkable = nearestWalkable(plan, cell);
          if (walkable !== cell) {
            Object.assign(actor, cellPoint(plan, walkable));
          }
        }
      }
    }
    if (this.firstSeen === undefined && members.length) {
      this.firstSeen = now;
    }
    const initial = !this.animate || this.firstSeen === undefined || now - this.firstSeen < SETTLE_MS;
    for (const member of members) {
      const actor = this.actorMap.get(member.key);
      if (actor) {
        actor.member = member;
        this.transition(actor, now);
      } else if (!this.departed.has(member.key) && !(member.sub && !isWorking(member.node.activity))) {
        this.add(member, now, initial);
      }
    }
    if (!this.cat) {
      const cell = this.randomLeisureCell() ?? plan.door;
      this.cat = { ...cellPoint(plan, cell), dir: "right", pose: "sleep", path: [], until: now + 8000 + this.random() * 20000 };
    } else if (changed) {
      Object.assign(this.cat, cellPoint(plan, nearestWalkable(plan, cellAt(plan, this.cat.x, this.cat.y))), { path: [] });
    }
  }

  public update(now: number, dt: number): void {
    const plan = this.plan;
    if (!plan || !this.animate) {
      return;
    }
    const seconds = Math.min(0.1, dt / 1000);
    this.inUse.clear();
    for (const actor of this.actorMap.values()) {
      this.step(actor, now, seconds);
      const current = actor.queue[0];
      if (current?.t === "pose" && current.use && current.begun) {
        this.inUse.add(current.use);
      }
      if (current?.t === "game" && current.game.start) {
        this.inUse.add(current.game.itemId);
      }
    }
    for (const actor of [...this.actorMap.values()]) {
      if (actor.gone) {
        this.departed.add(actor.key);
        this.drop(actor);
      }
    }
    for (let index = this.gameList.length - 1; index >= 0; index--) {
      const game = this.gameList[index]!;
      if (game.cancelled || (game.end && now >= game.end)) {
        this.gameList.splice(index, 1);
      }
    }
    this.moveCat(now, seconds);
  }

  /** Everyone straight to where they belong (resize, reduced motion toggled). */
  private reset(now: number): void {
    this.seatTaken.clear();
    this.poiTaken.clear();
    this.hotSeats.clear();
    this.gameList.length = 0;
    for (const actor of this.actorMap.values()) {
      this.clear(actor);
      actor.seat = undefined;
      this.place(actor, now);
    }
  }

  // ── Actors ────────────────────────────────────────────────────────────

  private add(member: Member, now: number, initial: boolean): void {
    const plan = this.plan!;
    const actor: Actor = {
      key: member.key,
      member,
      ...cellPoint(plan, plan.door),
      dir: "up",
      pose: "stand",
      alpha: 1,
      queue: [],
      path: [],
      stepStart: now,
      activity: member.node.activity,
      gone: false,
    };
    this.actorMap.set(member.key, actor);
    if (initial) {
      this.place(actor, now);
    } else {
      // Newcomers come in through the door.
      actor.alpha = 0;
    }
  }

  /** Puts an actor straight where it would end up: at its desk, or somewhere to relax. */
  private place(actor: Actor, now: number): void {
    const plan = this.plan!;
    actor.alpha = 1;
    actor.path = [];
    const seat = this.workSeat(actor);
    if (seat) {
      this.sitNow(actor, seat, Infinity, "work", now);
      return;
    }
    if (this.mode(actor) === "leave") {
      actor.gone = true;
      return;
    }
    const seats = plan.seats.filter((candidate) => candidate.kind !== "desk" && candidate.kind !== "hot" && !this.seatTaken.has(candidate.id));
    const chance = this.animate ? this.random() : 1;
    if (seats.length && chance > 0.45) {
      const choice = this.animate ? this.pickOne(seats) : seats[hash(actor.key) % seats.length]!;
      const sleepy = choice.pose === "sitFront" && (this.animate ? this.random() < 0.4 : hash(actor.key) % 3 === 0);
      this.sitNow(actor, choice, this.animate ? 4000 + this.random() * 16000 : Infinity, sleepy ? "sleep" : undefined, now);
      return;
    }
    const cells = this.leisureCells;
    const cell = cells.length ? cells[this.animate ? Math.floor(this.random() * cells.length) : hash(actor.key) % cells.length]! : plan.door;
    Object.assign(actor, cellPoint(plan, cell));
    actor.pose = "stand";
    actor.dir = "down";
    actor.queue = this.animate ? [{ t: "pose", pose: this.random() < 0.5 ? "phone" : "stand", ms: 1000 + this.random() * 5000, soft: true }] : [];
  }

  private sitNow(actor: Actor, seat: Seat, ms: number, pose: Pose | undefined, now: number): void {
    const plan = this.plan!;
    this.seatTaken.set(seat.id, actor.key);
    actor.x = seat.x;
    actor.y = seat.y;
    actor.queue = [{ t: "sit", seat, ms, pose, emote: pose === "sleep" ? "zzz" : undefined }];
    if (ms !== Infinity) {
      actor.queue.push({ t: "glide", ...cellPoint(plan, seat.cell) });
    }
    this.begin(actor, actor.queue[0]!, now);
  }

  private mode(actor: Actor): "work" | "leave" | "free" {
    const activity = actor.member.node.activity;
    if (isWorking(activity)) {
      return "work";
    }
    return actor.member.sub ? "leave" : "free";
  }

  /** The desk (or hot desk for a subagent) of an actor that has work to do. */
  private workSeat(actor: Actor): Seat | undefined {
    if (this.mode(actor) !== "work") {
      return undefined;
    }
    if (!actor.member.sub) {
      return this.deskOf.get(actor.key);
    }
    const plan = this.plan!;
    const assigned = this.hotSeats.get(actor.key);
    const seat = assigned ? plan.seats.find((candidate) => candidate.id === assigned) : undefined;
    if (seat) {
      return seat;
    }
    const free = plan.seats.find((candidate) => candidate.kind === "hot" && candidate.teamId === actor.member.teamId && ![...this.hotSeats.values()].includes(candidate.id));
    if (free) {
      this.hotSeats.set(actor.key, free.id);
    }
    return free;
  }

  private transition(actor: Actor, now: number): void {
    const before = actor.activity;
    const after = actor.member.node.activity;
    actor.activity = after;
    if (before === after || !this.animate) {
      if (!this.animate && before !== after) {
        this.clear(actor);
        this.place(actor, now);
      }
      return;
    }
    const wasWorking = isWorking(before);
    const working = isWorking(after);
    // Only starting or stopping work changes plans (a skipped step does not wake anyone up).
    if (working === wasWorking && after !== "failed") {
      return;
    }
    this.clear(actor);
    if (working) {
      return;
    }
    if (actor.member.sub) {
      return;
    }
    if (after === "done" && wasWorking) {
      actor.queue.push({ t: "pose", pose: "cheer", dir: "down", ms: 2600, emote: "check" });
    } else if (after === "failed") {
      actor.queue.push({ t: "pose", pose: "sad", dir: "down", ms: 3500, emote: "sweat" });
    }
  }

  /** Drops what the actor was doing; if it was sitting, it gets up first. */
  private clear(actor: Actor): void {
    for (const step of actor.queue) {
      if (step.t === "chat") {
        step.chat.cancelled = true;
      } else if (step.t === "game") {
        step.game.cancelled = true;
      }
    }
    this.release(actor);
    actor.queue = [];
    actor.path = [];
    actor.emote = undefined;
    if (actor.seat && this.plan) {
      actor.queue.push({ t: "glide", ...cellPoint(this.plan, actor.seat.cell) });
    }
    actor.seat = undefined;
  }

  private release(actor: Actor): void {
    for (const map of [this.seatTaken, this.poiTaken]) {
      for (const [id, owner] of map) {
        if (owner === actor.key) {
          map.delete(id);
        }
      }
    }
  }

  private drop(actor: Actor): void {
    this.clear(actor);
    this.hotSeats.delete(actor.key);
    this.actorMap.delete(actor.key);
  }

  private step(actor: Actor, now: number, seconds: number): void {
    if (actor.alpha < 1 && !actor.queue.some((step) => step.t === "leave")) {
      actor.alpha = Math.min(1, actor.alpha + seconds * 2);
    }
    if (actor.emote && actor.emote.until < now) {
      actor.emote = undefined;
    }
    const step = actor.queue[0];
    if (!step) {
      this.decide(actor, now);
      return;
    }
    if (!step.begun) {
      this.begin(actor, step, now);
    }
    if (this.advance(actor, step, now, seconds)) {
      actor.queue.shift();
      if (step.t === "sit") {
        actor.seat = undefined;
        this.seatTaken.delete(step.seat.id);
      }
    }
  }

  private begin(actor: Actor, step: Step, now: number): void {
    step.begun = true;
    actor.stepStart = now;
    switch (step.t) {
      case "walk": {
        const plan = this.plan!;
        actor.path = findPath(plan, cellAt(plan, actor.x, actor.y), step.cell) ?? [];
        break;
      }
      case "pose":
        actor.pose = step.pose;
        actor.dir = step.dir ?? actor.dir;
        actor.emote = step.emote ? { kind: step.emote, until: now + Math.min(step.ms, 4000) } : undefined;
        break;
      case "sit":
        actor.seat = step.seat;
        actor.pose = step.pose ?? step.seat.pose;
        actor.dir = step.seat.pose === "sitBack" ? "up" : "down";
        actor.emote = step.emote ? { kind: step.emote, until: now + step.ms } : undefined;
        break;
      case "chat":
        if (step.lead) {
          step.chat.start = now;
          step.chat.end = now + 6000 + this.random() * 6000;
        }
        break;
      case "game":
        actor.dir = step.poi.dir;
        actor.pose = "stand";
        step.game.arrived++;
        if (step.game.arrived === 2) {
          step.game.start = now;
          step.game.end = now + 10000 + this.random() * 8000;
        }
        break;
      case "leave":
      case "glide":
        break;
    }
  }

  /** Runs a step; true once it is finished. */
  private advance(actor: Actor, step: Step, now: number, seconds: number): boolean {
    const elapsed = now - actor.stepStart;
    switch (step.t) {
      case "walk": {
        const next = actor.path[0];
        if (next === undefined) {
          actor.pose = "stand";
          return true;
        }
        if (this.moveTowards(actor, cellPoint(this.plan!, next), SPEED * seconds)) {
          actor.path.shift();
        }
        return false;
      }
      case "glide":
        return this.moveTowards(actor, step, SPEED * 0.6 * seconds, true);
      case "pose":
        return elapsed >= step.ms;
      case "sit":
        if (step.pose === "work") {
          actor.pose = "work";
        }
        return elapsed >= step.ms;
      case "chat": {
        const chat = step.chat;
        if (chat.cancelled) {
          return true;
        }
        if (!chat.start) {
          actor.pose = "stand";
          if (elapsed > 15000) {
            chat.cancelled = true;
          }
          return chat.cancelled;
        }
        const other = step.lead ? chat.b : chat.a;
        actor.dir = other.x < actor.x ? "left" : "right";
        const turn = Math.floor((now - chat.start) / TALK_TURN_MS);
        const speaking = (turn % 2 === 0) === step.lead;
        actor.pose = speaking ? "talk" : "stand";
        if (speaking && (!actor.emote || actor.emote.until < now)) {
          actor.emote = { kind: CHAT_TOPICS[hash(`${chat.id}:${turn}`) % CHAT_TOPICS.length]!, until: chat.start + (turn + 1) * TALK_TURN_MS - 150 };
        }
        return now >= chat.end;
      }
      case "game": {
        const game = step.game;
        if (game.cancelled) {
          return true;
        }
        if (!game.start) {
          if (elapsed > 20000) {
            game.cancelled = true;
          }
          return game.cancelled;
        }
        actor.pose = "swing";
        actor.dir = step.poi.dir;
        return now >= game.end;
      }
      case "leave":
        actor.alpha = Math.max(0, actor.alpha - seconds * 2);
        actor.gone = actor.alpha === 0;
        return false;
    }
  }

  private moveTowards(actor: Actor, target: { x: number; y: number }, distance: number, keepDir = false): boolean {
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const length = Math.hypot(dx, dy);
    if (length <= distance || length < 0.01) {
      actor.x = target.x;
      actor.y = target.y;
      return true;
    }
    actor.x += (dx / length) * distance;
    actor.y += (dy / length) * distance;
    actor.pose = "walk";
    if (!keepDir) {
      actor.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    }
    return false;
  }

  /** Picks what to do next once the queue is empty. */
  private decide(actor: Actor, now: number): void {
    const plan = this.plan!;
    this.release(actor);
    switch (this.mode(actor)) {
      case "work": {
        const seat = this.workSeat(actor);
        if (!seat) {
          actor.queue.push({ t: "pose", pose: "phone", dir: "down", ms: 3000 });
        } else {
          this.seatTaken.set(seat.id, actor.key);
          if (Math.hypot(actor.x - seat.x, actor.y - seat.y) > 0.5) {
            actor.queue.push({ t: "walk", cell: seat.cell }, { t: "glide", x: seat.x, y: seat.y });
          }
          actor.queue.push({ t: "sit", seat, ms: Infinity, pose: "work" });
        }
        return;
      }
      case "leave":
        actor.queue.push({ t: "walk", cell: plan.door }, { t: "leave" });
        return;
      case "free":
        this.leisure(actor, now);
        return;
    }
  }

  private leisure(actor: Actor, now: number): void {
    const mood: Mood = actor.activity === "failed" ? "failed" : actor.activity === "done" ? "done" : "waiting";
    const options: [number, () => Step[] | null][] = [
      [mood === "done" ? 3 : 2, () => this.planSeat(actor)],
      [mood === "failed" ? 1.5 : 3, () => this.planPoi(actor)],
      [mood === "failed" ? 2 : 1.5, () => this.planWander(actor)],
      [mood === "failed" ? 1.5 : 3, () => this.planChat(actor)],
      [mood === "waiting" ? 1 : 1.5, () => this.planGame(actor)],
      [mood === "waiting" ? 3 : 0, () => this.planNap(actor)],
      [0.8, () => this.planPet(now)],
      [0.6, () => [{ t: "pose", pose: "yawn", dir: "down", ms: 2200 }]],
      [mood === "done" ? 0.7 : 0, () => [{ t: "pose", pose: "dance", dir: "down", ms: 4500, emote: "note" }]],
      [mood === "failed" ? 2 : 0, () => [{ t: "pose", pose: "sad", dir: "down", ms: 3500, emote: "cloud" }]],
    ];
    let pool = options.filter(([weight]) => weight > 0);
    while (pool.length) {
      const total = pool.reduce((sum, [weight]) => sum + weight, 0);
      let roll = this.random() * total;
      const index = pool.findIndex(([weight]) => (roll -= weight) < 0);
      const chosen = pool[index === -1 ? pool.length - 1 : index]!;
      const steps = chosen[1]();
      if (steps) {
        actor.queue.push(...steps, { t: "pose", pose: "stand", ms: 600 + this.random() * 1600, soft: true });
        return;
      }
      pool = pool.filter((option) => option !== chosen);
    }
    actor.queue.push({ t: "pose", pose: "stand", ms: 2000, soft: true });
  }

  private sitSteps(seat: Seat, ms: number, pose?: Pose, emote?: Emote): Step[] {
    const plan = this.plan!;
    return [
      { t: "walk", cell: seat.cell },
      { t: "glide", x: seat.x, y: seat.y },
      { t: "sit", seat, ms, pose, emote },
      { t: "glide", ...cellPoint(plan, seat.cell) },
    ];
  }

  private planSeat(actor: Actor): Step[] | null {
    const seats = this.plan!.seats.filter((seat) => seat.kind !== "desk" && seat.kind !== "hot" && !this.seatTaken.has(seat.id));
    if (!seats.length) {
      return null;
    }
    const seat = this.pickOne(seats);
    this.seatTaken.set(seat.id, actor.key);
    if (seat.pose === "sitFront" && seat.kind !== "stool" && this.random() < 0.45) {
      return this.sitSteps(seat, 12000 + this.random() * 20000, "sleep", "zzz");
    }
    return this.sitSteps(seat, 6000 + this.random() * 10000, undefined, seat.kind === "stool" ? "coffee" : undefined);
  }

  private planNap(actor: Actor): Step[] | null {
    const seat = this.deskOf.get(actor.key);
    if (!seat || this.seatTaken.has(seat.id)) {
      return null;
    }
    this.seatTaken.set(seat.id, actor.key);
    return this.sitSteps(seat, 10000 + this.random() * 15000, "nap", "zzz");
  }

  private planPoi(actor: Actor): Step[] | null {
    const pois = this.plan!.pois.filter((poi) => poi.kind !== "pingpong" && !this.poiTaken.has(poi.id));
    if (!pois.length) {
      return null;
    }
    const poi = this.pickOne(pois);
    this.poiTaken.set(poi.id, actor.key);
    const use = poi.itemId ?? poi.id;
    const walk: Step = { t: "walk", cell: poi.cell };
    const at = (pose: Pose, ms: number, emote?: Emote): Step => ({ t: "pose", pose, dir: poi.dir, ms, emote, use });
    const after = (pose: Pose, ms: number, emote?: Emote): Step => ({ t: "pose", pose, dir: "down", ms, emote });
    const r = (min: number, max: number): number => min + this.random() * (max - min);
    switch (poi.kind) {
      case "coffee":
        return [walk, at("stand", 3000, "dots"), after("drink", r(3000, 6000), "coffee")];
      case "cooler":
        return [walk, at("stand", 1500), after("drink", r(2500, 4500))];
      case "vending":
        return [walk, at("stand", 2500, "question"), after("drink", r(2500, 4000), "happy")];
      case "fridge":
        return [walk, at("stand", 3000, this.random() < 0.5 ? "question" : "heart")];
      case "microwave":
        return [walk, at("stand", 4000, "dots"), after("stand", 1500, "happy")];
      case "sink":
        return [walk, at("reach", 3000)];
      case "arcade":
        return [walk, at("play", r(8000, 16000), this.random() < 0.5 ? "star" : "note")];
      case "shelf":
        return [walk, at("reach", 1500), after("book", r(5000, 9000))];
      case "window":
        return [walk, at("stand", r(4000, 7000), this.random() < 0.3 ? "idea" : undefined)];
      case "whiteboard":
        return [walk, at("reach", r(3000, 6000), "idea")];
      case "printer":
        return [walk, at("stand", 3500, "dots")];
      case "dart":
        return [walk, at("reach", 900), at("stand", 700), at("reach", 900), at("stand", 700, this.random() < 0.5 ? "star" : "sweat")];
      case "pingpong":
        return null;
    }
  }

  private planWander(actor: Actor): Step[] | null {
    const claimed = this.claimedCells([actor]);
    const cells = this.leisureCells.filter((cell) => this.roomy(cell, claimed));
    if (!cells.length) {
      return null;
    }
    const pose: Pose = this.random() < 0.45 ? "phone" : "stand";
    return [
      { t: "walk", cell: this.pickOne(cells) },
      { t: "pose", pose, dir: "down", ms: 2000 + this.random() * 5000, soft: true },
    ];
  }

  /** People standing around who can be dragged into a conversation or a game. */
  private idlePartners(actor: Actor): Actor[] {
    return [...this.actorMap.values()].filter((other) => {
      if (other === actor || other.seat || other.alpha < 1 || this.mode(other) !== "free") {
        return false;
      }
      const step = other.queue[0];
      return !step || (step.t === "pose" && step.soft);
    });
  }

  private idlePartner(actor: Actor): Actor | undefined {
    const candidates = this.idlePartners(actor);
    return candidates.length ? this.pickOne(candidates) : undefined;
  }

  /** Where `actor` could stand to chat with `partner` without anyone else in the way. */
  private chatSpots(actor: Actor, partner: Actor): number[] {
    const plan = this.plan!;
    const cell = cellAt(plan, partner.x, partner.y);
    const claimed = this.claimedCells([actor, partner]);
    if (!this.roomy(cell, claimed)) {
      return [];
    }
    const row = Math.floor(cell / plan.cols);
    // Same row with nothing in between, so they do not talk through a wall or a desk.
    const clear = (side: number, distance: number) => {
      for (let step = 1; step <= distance; step++) {
        const spot = cell + side * step;
        if (spot < 0 || spot >= plan.walk.length || Math.floor(spot / plan.cols) !== row || !plan.walk[spot]) {
          return false;
        }
      }
      return true;
    };
    return CHAT_DISTANCES.flatMap((distance) =>
      [-1, 1].filter((side) => clear(side, distance) && this.roomy(cell + side * distance, claimed)).map((side) => cell + side * distance),
    );
  }

  private planChat(actor: Actor): Step[] | null {
    const plan = this.plan!;
    const options = this.idlePartners(actor)
      .map((partner) => ({ partner, spots: this.chatSpots(actor, partner) }))
      .filter((option) => option.spots.length);
    if (!options.length) {
      return null;
    }
    const { partner, spots } = this.pickOne(options);
    const chat: Chat = { id: ++this.ids, a: actor, b: partner, start: 0, end: 0, cancelled: false };
    this.clear(partner);
    partner.queue.push(...(partner.queue.length ? [] : [{ t: "glide", ...cellPoint(plan, cellAt(plan, partner.x, partner.y)) } as Step]), { t: "chat", chat, lead: false });
    return [
      { t: "walk", cell: spots[0]! },
      { t: "chat", chat, lead: true },
    ];
  }

  /**
   * Cells taken by someone standing there or heading there, plus the spots people walk up to
   * (machines, seats), so a new plan does not drop anyone on top of somebody else.
   */
  private claimedCells(except: readonly Actor[]): number[] {
    const plan = this.plan!;
    const cells = [...plan.pois.map((poi) => poi.cell), ...plan.seats.map((seat) => seat.cell)];
    for (const actor of this.actorMap.values()) {
      if (except.includes(actor) || actor.gone) {
        continue;
      }
      if (!actor.seat && actor.queue[0]?.t !== "walk") {
        cells.push(cellAt(plan, actor.x, actor.y));
      }
      for (const step of actor.queue) {
        if (step.t === "walk") {
          cells.push(step.cell);
        } else if (step.t === "glide") {
          cells.push(cellAt(plan, step.x, step.y));
        }
      }
    }
    return cells;
  }

  /** Room to stand on `cell`: a body is two cells wide and reaches into the row behind. */
  private roomy(cell: number, claimed: readonly number[]): boolean {
    const cols = this.plan!.cols;
    const c = cell % cols;
    const r = Math.floor(cell / cols);
    return claimed.every((other) => Math.abs((other % cols) - c) >= 2 || Math.abs(Math.floor(other / cols) - r) >= 2);
  }

  private planGame(actor: Actor): Step[] | null {
    const tables = this.plan!.pois.filter((poi) => poi.kind === "pingpong" && poi.pair && !this.poiTaken.has(poi.id) && !this.poiTaken.has(poi.pair));
    const left = tables.find((poi) => poi.dir === "right");
    const right = left && this.plan!.pois.find((poi) => poi.id === left.pair);
    const partner = right && this.idlePartner(actor);
    if (!left || !right || !partner) {
      return null;
    }
    const game: Game = { id: ++this.ids, a: actor, b: partner, left, right, itemId: left.itemId ?? left.id, start: 0, end: 0, arrived: 0, cancelled: false };
    this.gameList.push(game);
    this.clear(partner);
    this.poiTaken.set(left.id, actor.key);
    this.poiTaken.set(right.id, partner.key);
    partner.queue.push({ t: "walk", cell: right.cell }, { t: "game", game, poi: right });
    return [
      { t: "walk", cell: left.cell },
      { t: "game", game, poi: left },
    ];
  }

  private planPet(now: number): Step[] | null {
    const plan = this.plan!;
    const cat = this.cat;
    if (!cat || cat.pose === "walk") {
      return null;
    }
    const cell = cellAt(plan, cat.x, cat.y);
    const spot = [cell - 1, cell + 1].find((candidate) => plan.walk[candidate]);
    if (spot === undefined) {
      return null;
    }
    cat.until = Math.max(cat.until, now + 15000);
    return [
      { t: "walk", cell: spot },
      { t: "pose", pose: "pet", dir: spot < cell ? "right" : "left", ms: 3500, emote: "heart" },
    ];
  }

  private computeLeisureCells(plan: Plan): number[] {
    const cells: number[] = [];
    for (let index = 0; index < plan.walk.length; index++) {
      if (!plan.walk[index] || index === plan.door) {
        continue;
      }
      const x = (index % plan.cols) * TILE;
      const y = Math.floor(index / plan.cols) * TILE;
      const inPod = plan.pods.some((pod) => x >= pod.x && x < pod.x + pod.w && y >= pod.y && y < pod.y + pod.h);
      if (!inPod && plan.floor[index] !== FLOOR.wall) {
        cells.push(index);
      }
    }
    return cells;
  }

  private randomLeisureCell(): number | undefined {
    const cells = this.leisureCells;
    return cells.length ? cells[Math.floor(this.random() * cells.length)] : undefined;
  }

  private pickOne<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!;
  }

  // ── The cat ───────────────────────────────────────────────────────────

  private moveCat(now: number, seconds: number): void {
    const cat = this.cat;
    const plan = this.plan!;
    if (!cat) {
      return;
    }
    if (cat.emote && cat.emote.until < now) {
      cat.emote = undefined;
    }
    if (this.actors.some((actor) => actor.pose === "pet" && Math.hypot(actor.x - cat.x, actor.y - cat.y) < 14)) {
      cat.emote ??= { kind: "heart", until: now + 1500 };
    }
    if (cat.path.length) {
      const target = cellPoint(plan, cat.path[0]!);
      const dx = target.x - cat.x;
      const dy = target.y - cat.y;
      const length = Math.hypot(dx, dy);
      const distance = CAT_SPEED * seconds;
      if (length <= distance) {
        cat.x = target.x;
        cat.y = target.y;
        cat.path.shift();
      } else {
        cat.x += (dx / length) * distance;
        cat.y += (dy / length) * distance;
        if (Math.abs(dx) > 0.1) {
          cat.dir = dx < 0 ? "left" : "right";
        }
      }
      cat.pose = cat.path.length ? "walk" : cat.pose;
      if (!cat.path.length) {
        const nap = this.random() < 0.5;
        cat.pose = nap ? "sleep" : "sit";
        cat.until = now + (nap ? 15000 + this.random() * 30000 : 3000 + this.random() * 6000);
      }
      return;
    }
    if (now < cat.until) {
      if (cat.pose === "sleep" && !cat.emote && this.random() < seconds * 0.2) {
        cat.emote = { kind: "zzz", until: now + 2500 };
      }
      return;
    }
    const target = this.randomLeisureCell();
    const path = target === undefined ? null : findPath(plan, cellAt(plan, cat.x, cat.y), target);
    if (path?.length) {
      cat.path = path.slice(0, 24);
      cat.pose = "walk";
    } else {
      cat.until = now + 5000;
    }
  }
}
