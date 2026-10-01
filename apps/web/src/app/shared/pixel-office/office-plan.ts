// Floor plan of the office: rooms, walls, furniture, seats and points of interest on a tile
// grid. Pure (no DOM) so it can be tested; the renderer paints it and the simulation walks it.
import type { AgentNode } from "../../core/agents";
import { lookFor, type Look } from "./looks";

export const TILE = 8;
/** Rows of a wall seen from the front: a dark top edge and two rows of wall face. */
const WALL_ROWS = 3;
/** A desk slot is 4 tiles wide and a desk row 6 tiles tall (desk, chair, aisle). */
const SLOT = 4;
const DESK_ROW = 6;
const LOUNGE_COLS = 17;
const LOUNGE_ROWS = 11;
const KITCHEN_ROWS = 8;
const GAMES_ROWS = 8;
const MIN_WORK_COLS = 12;
const MIN_COLS = 14;
/** Free hot desks each flow keeps for its subagents, so a new subagent does not reflow the office. */
const MIN_HOT_DESKS = 2;
/** Feet of someone sitting at a desk, from the top of the desk row (px). */
const DESK_SEAT_Y = 41;

export type Dir = "down" | "up" | "left" | "right";

/** A flow in the office. Only live flows get desks; the agents of finished ones just hang around. */
export type OfficeTeam = { id: string; title: string; color: string; live: boolean; agents: readonly AgentNode[] };

/** One character: a step of a flow (whatever its attempt) or a subagent. */
export type Member = { key: string; teamId: string; color: string; node: AgentNode; sub: boolean; parentKey?: string; look: Look };

export const FLOOR = { wall: 0, face: 1, wood: 2, carpet: 3, tiles: 4, games: 5 } as const;

export type ItemKind =
  | "desk"
  | "hotDesk"
  | "chair"
  | "stool"
  | "sofaDown"
  | "sofaUp"
  | "coffeeTable"
  | "plant"
  | "lamp"
  | "counter"
  | "fridge"
  | "vending"
  | "cooler"
  | "roundTable"
  | "meetingTable"
  | "arcade"
  | "pingpong"
  | "beanbag"
  | "printer"
  | "bin";

/** Furniture on a footprint of cells; it may be drawn taller than its footprint. */
export type Item = {
  id: string;
  kind: ItemKind;
  c: number;
  r: number;
  w: number;
  h: number;
  variant: number;
  color?: string;
  /** Seat that belongs to this piece (desks: whose screen to light up). */
  seat?: string;
  /** Counter segments: what stands on them. */
  appliance?: "coffee" | "sink" | "microwave" | "fruit" | "plain";
  /** Draw order override (px); by default the bottom of the footprint. */
  z?: number;
};

/** `trophies` and `shop` link to Logros and Tienda (the 3D office has the same two). */
export type DecorKind = "shelf" | "window" | "clock" | "picture" | "tv" | "whiteboard" | "dartboard" | "cabinets" | "door" | "rug" | "mat" | "trophies" | "shop";

/** Painted on the background: wall decoration, rugs, the entrance. Pixels. */
export type Decor = { kind: DecorKind; x: number; y: number; w: number; h: number; variant: number; color?: string };

export type SeatKind = "desk" | "hot" | "sofa" | "stool" | "beanbag";

export type Seat = {
  id: string;
  kind: SeatKind;
  /** Where the character's feet go once seated (px). */
  x: number;
  y: number;
  /** Walkable cell next to the seat, where the character gets in and out. */
  cell: number;
  pose: "sitBack" | "sitFront";
  teamId?: string;
  /** Member that owns this desk. */
  owner?: string;
  itemId?: string;
};

export type PoiKind = "coffee" | "sink" | "microwave" | "fridge" | "vending" | "cooler" | "arcade" | "shelf" | "window" | "whiteboard" | "printer" | "dart" | "pingpong";

/** Something to stand in front of. */
export type Poi = { id: string; kind: PoiKind; cell: number; dir: Dir; itemId?: string; pair?: string };

export type Pod = { teamId: string; title: string; color: string; x: number; y: number; w: number; h: number };

export type RoomKey = "work" | "lounge" | "kitchen" | "games";
export type Room = { key: RoomKey; c: number; r: number; w: number; h: number };

export type Plan = {
  cols: number;
  rows: number;
  width: number;
  height: number;
  /** FLOOR kind per cell. */
  floor: Uint8Array;
  /** 1 = anyone can walk on it. Seat cells are blocked but reachable as a destination. */
  walk: Uint8Array;
  items: Item[];
  decor: Decor[];
  seats: Seat[];
  pois: Poi[];
  pods: Pod[];
  rooms: Room[];
  /** Entrance cell: newcomers appear here and leaving subagents vanish here. */
  door: number;
  wide: boolean;
  /** Same signature = same plan, so the simulation can keep everyone where they are. */
  signature: string;
};

const FREE = new Set(["done", "failed"]);

/** Characters of the office: the last attempt of each step and the subagents it launched. */
export function officeMembers(teams: readonly OfficeTeam[]): Member[] {
  const members: Member[] = [];
  for (const team of teams) {
    const bySteps = new Map<string, AgentNode>();
    for (const node of team.agents) {
      bySteps.set(node.step, node);
    }
    for (const node of bySteps.values()) {
      const key = `${team.id}:${node.step}`;
      const robot = Boolean(node.builtin);
      members.push({
        key,
        teamId: team.id,
        color: team.color,
        node,
        sub: false,
        look: lookFor({ seed: `${node.runId}:${node.step}`, model: node.model, step: node.step, robot, subagent: false, team: team.color }),
      });
      for (const child of node.children) {
        members.push({
          key: `${team.id}:sub:${child.id}`,
          teamId: team.id,
          color: team.color,
          node: child,
          sub: true,
          parentKey: key,
          look: lookFor({ seed: child.id, model: child.model, step: "subagent", robot: false, subagent: true, team: team.color }),
        });
      }
    }
  }
  return members;
}

class Builder {
  public readonly floor: Uint8Array;
  public readonly blocked: Uint8Array;
  public readonly items: Item[] = [];
  public readonly decor: Decor[] = [];
  public readonly seats: Seat[] = [];
  public readonly pois: Poi[] = [];
  public readonly cols: number;
  public readonly rows: number;

  public constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.floor = new Uint8Array(cols * rows);
    this.blocked = new Uint8Array(cols * rows);
  }

  public cell(c: number, r: number): number {
    return r * this.cols + c;
  }

  public paint(c: number, r: number, w: number, h: number, kind: number): void {
    for (let y = r; y < r + h; y++) {
      for (let x = c; x < c + w; x++) {
        if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) {
          this.floor[this.cell(x, y)] = kind;
        }
      }
    }
  }

  public block(c: number, r: number, w: number, h: number): void {
    for (let y = r; y < r + h; y++) {
      for (let x = c; x < c + w; x++) {
        if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) {
          this.blocked[this.cell(x, y)] = 1;
        }
      }
    }
  }

  public free(c: number, r: number): boolean {
    const index = this.cell(c, r);
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.floor[index]! >= FLOOR.wood && !this.blocked[index];
  }

  public item(kind: ItemKind, c: number, r: number, w: number, h: number, extra: Partial<Item> = {}, solid = true): Item {
    const item: Item = { id: `${kind}:${c}:${r}`, kind, c, r, w, h, variant: 0, ...extra };
    this.items.push(item);
    if (solid) {
      this.block(c, r, w, h);
    }
    return item;
  }

  public seat(seat: Omit<Seat, "cell"> & { c: number; r: number }): Seat {
    const { c, r, ...rest } = seat;
    const result: Seat = { ...rest, cell: this.cell(c, r) };
    this.seats.push(result);
    return result;
  }

  public poi(kind: PoiKind, c: number, r: number, dir: Dir, extra: Partial<Poi> = {}): void {
    if (this.free(c, r)) {
      this.pois.push({ id: `${kind}:${c}:${r}`, kind, cell: this.cell(c, r), dir, ...extra });
    }
  }

  /** Horizontal wall between stacked rooms, with 3-tile doorways (by default one in the middle). */
  public innerWall(c: number, r: number, w: number, below: number, doors = [doorway(c, w)]): void {
    this.paint(c, r, w, 1, FLOOR.wall);
    this.paint(c, r + 1, w, WALL_ROWS - 1, FLOOR.face);
    for (const door of doors) {
      this.paint(door, r, 3, WALL_ROWS, below);
      this.decor.push({ kind: "door", x: door * TILE, y: r * TILE, w: 3 * TILE, h: WALL_ROWS * TILE, variant: 1 });
    }
  }
}

/** First column of the doorway centred on a room of width `w` starting at `c`. */
function doorway(c: number, w: number): number {
  return c + Math.floor(w / 2) - 1;
}

type PodSize = { team: OfficeTeam; desks: Member[]; hot: number; w: number; h: number; perRow: number };

function podSize(team: OfficeTeam, members: readonly Member[], perRowMax: number): PodSize {
  const own = members.filter((member) => member.teamId === team.id);
  const desks = own.filter((member) => !member.sub);
  const activeSubs = own.filter((member) => member.sub && !FREE.has(member.node.activity)).length;
  const hot = Math.max(MIN_HOT_DESKS, activeSubs);
  const slots = desks.length + hot;
  const perRow = Math.max(1, Math.min(slots, perRowMax));
  return { team, desks, hot, perRow, w: perRow * SLOT + 2, h: 1 + Math.ceil(slots / perRow) * DESK_ROW };
}

/** Lays out the whole office for `widthPx` art pixels. Live flows get a pod of desks each. */
export function planOffice(teams: readonly OfficeTeam[], members: readonly Member[], widthPx: number): Plan {
  const cols = Math.max(MIN_COLS, Math.floor(widthPx / TILE));
  // Extra wide: lounge and kitchen side by side and the games room under both (a shorter office).
  const extraWide = cols >= MIN_WORK_COLS + 2 * LOUNGE_COLS + 4;
  const wide = extraWide || cols >= MIN_WORK_COLS + LOUNGE_COLS + 3;
  const workCols = extraWide ? cols - 2 * LOUNGE_COLS - 4 : wide ? cols - LOUNGE_COLS - 3 : cols - 2;
  const usable = workCols - 2;
  const perRowMax = Math.max(1, Math.floor((usable - 2) / SLOT));

  // Pods packed in lines inside the work area, below a corridor along the back wall.
  const sizes = teams.filter((team) => team.live).map((team) => podSize(team, members, perRowMax));
  const placed: { size: PodSize; c: number; r: number }[] = [];
  const firstRow = WALL_ROWS + 2;
  let cx = 2;
  let cy = firstRow;
  let lineH = 0;
  for (const size of sizes) {
    if (cx > 2 && cx + size.w > 2 + usable) {
      cx = 2;
      cy += lineH + 1;
      lineH = 0;
    }
    placed.push({ size, c: cx, r: cy });
    cx += size.w + 1;
    lineH = Math.max(lineH, size.h);
  }
  const workRows = Math.max(9, (placed.length ? cy + lineH : firstRow + 4) - WALL_ROWS + 2);

  // The games room is always there; when the work area is taller, it takes the extra height.
  const breakRows = extraWide ? LOUNGE_ROWS + WALL_ROWS + GAMES_ROWS : LOUNGE_ROWS + WALL_ROWS + KITCHEN_ROWS + WALL_ROWS + GAMES_ROWS;
  const floorRows = wide ? Math.max(workRows, breakRows) : workRows + WALL_ROWS + breakRows;
  const gamesRows = wide ? floorRows - (breakRows - GAMES_ROWS) : GAMES_ROWS;
  const rows = WALL_ROWS + floorRows + 1;
  const b = new Builder(cols, rows);
  b.paint(0, 1, cols, WALL_ROWS - 1, FLOOR.face);

  const rooms: Room[] = [];
  const work: Room = { key: "work", c: 1, r: WALL_ROWS, w: workCols, h: wide ? floorRows : workRows };
  rooms.push(work);
  b.paint(work.c, work.r, work.w, work.h, FLOOR.wood);
  let lounge: Room;
  let kitchen: Room;
  let games: Room;
  if (extraWide) {
    const p = work.c + work.w;
    const q = p + 1 + LOUNGE_COLS;
    lounge = { key: "lounge", c: p + 1, r: WALL_ROWS, w: LOUNGE_COLS, h: LOUNGE_ROWS };
    kitchen = { key: "kitchen", c: q + 1, r: WALL_ROWS, w: LOUNGE_COLS, h: LOUNGE_ROWS };
    games = { key: "games", c: p + 1, r: lounge.r + LOUNGE_ROWS + WALL_ROWS, w: 2 * LOUNGE_COLS + 1, h: gamesRows };
    b.paint(lounge.c, lounge.r, lounge.w, lounge.h, FLOOR.carpet);
    b.paint(kitchen.c, kitchen.r, kitchen.w, kitchen.h, FLOOR.tiles);
    b.paint(games.c, games.r, games.w, games.h, FLOOR.games);
    b.innerWall(games.c, lounge.r + lounge.h, games.w, FLOOR.games, [doorway(lounge.c, lounge.w), doorway(kitchen.c, kitchen.w)]);
    b.paint(p, lounge.r + 5, 1, 3, FLOOR.carpet);
    b.paint(q, lounge.r + 5, 1, 3, FLOOR.tiles);
    b.paint(p, games.r + 2, 1, 3, FLOOR.games);
  } else if (wide) {
    const p = work.c + work.w;
    lounge = { key: "lounge", c: p + 1, r: WALL_ROWS, w: LOUNGE_COLS, h: LOUNGE_ROWS };
    kitchen = { key: "kitchen", c: p + 1, r: lounge.r + LOUNGE_ROWS + WALL_ROWS, w: LOUNGE_COLS, h: KITCHEN_ROWS };
    games = { key: "games", c: p + 1, r: kitchen.r + kitchen.h + WALL_ROWS, w: LOUNGE_COLS, h: gamesRows };
    b.paint(lounge.c, lounge.r, lounge.w, lounge.h, FLOOR.carpet);
    b.paint(kitchen.c, kitchen.r, kitchen.w, kitchen.h, FLOOR.tiles);
    b.innerWall(lounge.c, lounge.r + lounge.h, lounge.w, FLOOR.tiles);
    // Doorways in the partition between the work area and the right-hand rooms.
    b.paint(p, lounge.r + 5, 1, 3, FLOOR.carpet);
    b.paint(p, kitchen.r + 2, 1, 3, FLOOR.tiles);
    b.paint(games.c, games.r, games.w, games.h, FLOOR.games);
    b.innerWall(games.c, kitchen.r + kitchen.h, games.w, FLOOR.games);
    b.paint(p, games.r + 2, 1, 3, FLOOR.games);
  } else {
    lounge = { key: "lounge", c: 1, r: work.r + work.h + WALL_ROWS, w: workCols, h: LOUNGE_ROWS };
    kitchen = { key: "kitchen", c: 1, r: lounge.r + lounge.h + WALL_ROWS, w: workCols, h: KITCHEN_ROWS };
    games = { key: "games", c: 1, r: kitchen.r + kitchen.h + WALL_ROWS, w: workCols, h: gamesRows };
    b.paint(lounge.c, lounge.r, lounge.w, lounge.h, FLOOR.carpet);
    b.paint(kitchen.c, kitchen.r, kitchen.w, kitchen.h, FLOOR.tiles);
    b.paint(games.c, games.r, games.w, games.h, FLOOR.games);
    b.innerWall(1, work.r + work.h, workCols, FLOOR.carpet);
    b.innerWall(1, lounge.r + lounge.h, workCols, FLOOR.tiles);
    b.innerWall(1, kitchen.r + kitchen.h, workCols, FLOOR.games);
  }
  rooms.push(lounge, kitchen, games);

  // Entrance in the bottom wall: under the work area, or under the games room when stacked.
  const entrance = wide ? work : games;
  const doorC = entrance.c + Math.floor(entrance.w / 2) - 1;
  b.decor.push({ kind: "door", x: doorC * TILE, y: (rows - 1) * TILE, w: 2 * TILE, h: TILE, variant: 0 });
  b.decor.push({ kind: "mat", x: doorC * TILE + 1, y: (rows - 2) * TILE + 2, w: 2 * TILE - 2, h: TILE - 3, variant: 0 });
  const door = b.cell(doorC, rows - 2);

  furnishWork(b, work, placed.length === 0);
  const pods = placed.map(({ size, c, r }) => furnishPod(b, size, c, r));
  furnishLounge(b, lounge);
  furnishKitchen(b, kitchen, !extraWide);
  furnishGames(b, games);

  const walk = new Uint8Array(cols * rows);
  for (let index = 0; index < walk.length; index++) {
    walk[index] = b.floor[index]! >= FLOOR.wood && !b.blocked[index] ? 1 : 0;
  }
  const signature = JSON.stringify([cols, rows, placed.map(({ size, c, r }) => [size.team.id, c, r, size.hot, size.desks.map((member) => member.key)])]);
  return {
    cols,
    rows,
    width: cols * TILE,
    height: rows * TILE,
    floor: b.floor,
    walk,
    items: b.items,
    decor: b.decor,
    seats: b.seats,
    pois: b.pois,
    pods,
    rooms,
    door,
    wide,
    signature,
  };
}

function furnishWork(b: Builder, room: Room, empty: boolean): void {
  const { c, r, w } = room;
  b.item("plant", c, r, 1, 1, { variant: 1 });
  b.item("plant", c + w - 1, r, 1, 1, { variant: 0 });
  if (w >= 10) {
    b.item("printer", c + 2, r, 2, 1);
    b.poi("printer", c + 2, r + 1, "up");
    b.item("cooler", c + w - 3, r, 1, 1);
    b.poi("cooler", c + w - 3, r + 1, "up");
    b.item("bin", c + 4, r, 1, 1);
  }
  // Wall decoration along the back wall, with a spot to stand in front of each piece.
  // The clock only once; then windows, shelves and whiteboards repeat.
  const pattern: [DecorKind, number][] = [
    ["window", 3],
    ["trophies", 3],
    ["clock", 2],
    ["whiteboard", 4],
    ["shop", 3],
    ["window", 3],
  ];
  const repeat = [0, 1, 3, 4, 5];
  let x = c + 1;
  for (let index = 0; ; index++) {
    const [kind, size] = pattern[index < pattern.length ? index : repeat[index % repeat.length]!]!;
    if (x + size > c + w - 1) {
      break;
    }
    if (kind === "clock") {
      b.decor.push({ kind, x: x * TILE + 4, y: TILE + 3, w: 8, h: 8, variant: 0 });
    } else {
      b.decor.push({ kind, x: x * TILE + 2, y: TILE + 1, w: size * TILE - 4, h: 2 * TILE - 2, variant: index });
      b.poi(kind === "shelf" || kind === "trophies" || kind === "shop" ? "shelf" : kind === "window" ? "window" : "whiteboard", x + Math.floor(size / 2), r, "up");
    }
    x += size + 1;
  }
  if (empty) {
    b.decor.push({ kind: "rug", x: (c + 2) * TILE, y: (r + 3) * TILE, w: (w - 4) * TILE, h: 4 * TILE, variant: 1 });
  }
}

function furnishPod(b: Builder, size: PodSize, pc: number, pr: number): Pod {
  const { team } = size;
  b.decor.push({ kind: "rug", x: pc * TILE + 2, y: (pr + 1) * TILE - 2, w: size.w * TILE - 4, h: (size.h - 1) * TILE, variant: 0, color: team.color });
  const slots = size.desks.length + size.hot;
  for (let index = 0; index < slots; index++) {
    const sc = pc + 1 + (index % size.perRow) * SLOT;
    const sr = pr + 1 + Math.floor(index / size.perRow) * DESK_ROW;
    const owner = size.desks[index];
    const id = owner ? `desk:${owner.key}` : `hot:${team.id}:${index - size.desks.length}`;
    const desk = b.item(owner ? "desk" : "hotDesk", sc, sr, SLOT, 3, { seat: id, variant: owner ? deskProp(owner) : 0 });
    b.block(sc, sr + 3, SLOT, 2);
    // The chair's backrest is drawn over the lower back of whoever sits on it.
    b.item(owner ? "chair" : "stool", sc + 1, sr + 4, 2, 1, { color: team.color, seat: id, z: owner ? sr * TILE + DESK_SEAT_Y + 1 : undefined }, false);
    b.seat({ id, kind: owner ? "desk" : "hot", x: sc * TILE + 16, y: sr * TILE + DESK_SEAT_Y, c: sc + 1, r: sr + 4, pose: "sitBack", teamId: team.id, owner: owner?.key, itemId: desk.id });
  }
  return { teamId: team.id, title: team.title, color: team.color, x: pc * TILE, y: pr * TILE, w: size.w * TILE, h: size.h * TILE };
}

/** A little something on each desk: the implementer gets the rubber duck. */
function deskProp(member: Member): number {
  if (member.node.step === "implement") {
    return 1;
  }
  let value = 0;
  for (const char of member.key) {
    value = (value * 31 + char.charCodeAt(0)) >>> 0;
  }
  return 2 + (value % 4);
}

function sofaSeats(b: Builder, item: Item, facing: "down" | "up"): void {
  for (let index = 0; index < 2; index++) {
    const c = item.c + index * 2;
    if (facing === "down") {
      b.seat({ id: `sofa:${item.c}:${item.r}:${index}`, kind: "sofa", x: item.c * TILE + 8 + index * 16, y: (item.r + 2) * TILE + 2, c, r: item.r + 2, pose: "sitFront", itemId: item.id });
    } else {
      b.seat({ id: `sofa:${item.c}:${item.r}:${index}`, kind: "sofa", x: item.c * TILE + 8 + index * 16, y: (item.r + 1) * TILE + 7, c, r: item.r - 1, pose: "sitBack", itemId: item.id });
    }
  }
}

function beanbag(b: Builder, c: number, r: number, variant: number): void {
  const item = b.item("beanbag", c, r, 2, 1, { variant });
  b.seat({ id: `beanbag:${c}:${r}`, kind: "beanbag", x: c * TILE + 8, y: (r + 1) * TILE + 1, c, r: r + 1, pose: "sitFront", itemId: item.id });
}

function furnishLounge(b: Builder, room: Room): void {
  const { c, r, w, h } = room;
  const faceY = (r - 2) * TILE;
  b.item("plant", c, r, 1, 1, { variant: 1 });
  b.item("plant", c + w - 1, r, 1, 1, { variant: 2 });
  b.item("lamp", c, r + 2, 1, 1);
  const gx = c + Math.max(1, Math.floor((w - 8) / 2));
  b.decor.push({ kind: "rug", x: (gx - 1) * TILE + 2, y: (r + 3) * TILE - 2, w: 6 * TILE - 4, h: 4 * TILE + 4, variant: 2 });
  sofaSeats(b, b.item("sofaDown", gx, r + 1, 4, 2, { variant: 0 }), "down");
  b.item("coffeeTable", gx, r + 4, 4, 2);
  if (h >= 9) {
    sofaSeats(b, b.item("sofaUp", gx, r + 7, 4, 2, { variant: 0 }), "up");
  }
  b.decor.push({ kind: "tv", x: gx * TILE + 4, y: faceY + 2, w: 24, h: 13, variant: 0 });
  if (gx - c >= 3) {
    b.decor.push({ kind: "picture", x: (c + 1) * TILE + 2, y: faceY + 3, w: 10, h: 10, variant: 0 });
  }
  b.item("arcade", c + w - 4, r, 2, 1, { variant: 0 });
  b.poi("arcade", c + w - 4, r + 1, "up");
  if (w >= 16) {
    b.item("arcade", c + w - 7, r, 2, 1, { variant: 1 });
    b.poi("arcade", c + w - 7, r + 1, "up");
    b.decor.push({ kind: "picture", x: (gx + 5) * TILE, y: faceY + 3, w: 10, h: 10, variant: 1 });
  }
  if (h >= 10 && w >= 13) {
    beanbag(b, c + w - 4, r + h - 3, 0);
    beanbag(b, c + w - 7, r + h - 3, 1);
  }
}

/** `gapped`: leave the counters open under the doorway of a room above. */
function furnishKitchen(b: Builder, room: Room, gapped: boolean): void {
  const { c, r, w, h } = room;
  const faceY = (r - 2) * TILE;
  b.item("fridge", c, r, 2, 1);
  b.poi("fridge", c, r + 1, "up");
  // Counters along the wall, leaving clear the doorway from the room above (same column as Builder.innerWall).
  const gap = gapped ? doorway(c, w) : -10;
  const appliances = ["plain", "coffee", "plain", "sink", "microwave", "fruit", "coffee", "plain"] as const;
  const counterEnd = c + w - 3;
  let next = 0;
  for (let x = c + 2; x < counterEnd; x++) {
    if (x >= gap && x < gap + 3) {
      continue;
    }
    const appliance = appliances[next++ % appliances.length]!;
    const edge = x === c + 2 || x === gap + 3 ? 1 : x === counterEnd - 1 || x === gap - 1 ? 2 : 0;
    b.item("counter", x, r, 1, 1, { appliance, variant: edge });
    if (appliance === "coffee" || appliance === "sink" || appliance === "microwave") {
      b.poi(appliance, x, r + 1, "up", { itemId: `counter:${x}:${r}` });
    }
  }
  if (gapped) {
    b.decor.push({ kind: "cabinets", x: (c + 2) * TILE, y: faceY + 1, w: Math.max(0, gap - c - 2) * TILE, h: 9, variant: 0 });
    b.decor.push({ kind: "cabinets", x: (gap + 3) * TILE, y: faceY + 1, w: Math.max(0, counterEnd - gap - 3) * TILE, h: 9, variant: 1 });
  } else {
    b.decor.push({ kind: "cabinets", x: (c + 2) * TILE, y: faceY + 1, w: (counterEnd - c - 2) * TILE, h: 9, variant: 0 });
  }
  b.item("vending", c + w - 3, r, 2, 1);
  b.poi("vending", c + w - 3, r + 1, "up");
  b.item("cooler", c + w - 1, r, 1, 1);
  b.poi("cooler", c + w - 1, r + 1, "up");
  if (h >= 7) {
    for (let index = 0; index < Math.floor((w - 2) / 5); index++) {
      const tc = c + 2 + index * 5;
      b.item("roundTable", tc, r + 3, 2, 2, { variant: index });
      tableSeats(b, tc, r + 3);
      if (h >= 11) {
        b.item("roundTable", tc, r + 7, 2, 2, { variant: index + 1 });
        tableSeats(b, tc, r + 7);
      }
    }
  }
  b.item("plant", c + w - 1, r + h - 1, 1, 1, { variant: 2 });
}

/** A stool behind a two-row table (sitting towards us) and another in front of it (back to us). */
function tableSeats(b: Builder, c: number, tableRow: number): void {
  b.item("stool", c, tableRow - 1, 1, 1, { z: tableRow * TILE - 1 });
  b.seat({ id: `stool:${c}:${tableRow - 1}`, kind: "stool", x: c * TILE + 8, y: tableRow * TILE + 2, c, r: tableRow - 1, pose: "sitFront" });
  b.item("stool", c, tableRow + 2, 1, 1, { z: (tableRow + 2) * TILE + 2 });
  b.seat({ id: `stool:${c}:${tableRow + 2}`, kind: "stool", x: c * TILE + 8, y: (tableRow + 2) * TILE + 6, c, r: tableRow + 2, pose: "sitBack" });
}

function furnishGames(b: Builder, room: Room): void {
  const { c, r, w, h } = room;
  const faceY = (r - 2) * TILE;
  const cx = c + Math.floor(w / 2);
  const tables = w >= 30 ? [c + Math.floor(w / 4), c + Math.floor((3 * w) / 4)] : [cx];
  for (const tx of tables) {
    // Players stand at the height of the table's middle, so it is drawn before them.
    const table = b.item("pingpong", tx - 2, r + 3, 4, 2, { z: (r + 4) * TILE + 4 });
    const left = `pingpong:${tx - 3}:${r + 4}`;
    const right = `pingpong:${tx + 2}:${r + 4}`;
    b.poi("pingpong", tx - 3, r + 4, "right", { itemId: table.id, pair: right });
    b.poi("pingpong", tx + 2, r + 4, "left", { itemId: table.id, pair: left });
  }
  b.decor.push({ kind: "dartboard", x: (c + 2) * TILE, y: faceY + 3, w: 10, h: 10, variant: 0 });
  b.poi("dart", c + 2, r + 2, "up");
  b.item("plant", c + w - 1, r, 1, 1, { variant: 1 });
  b.item("arcade", c + w - 4, r, 2, 1, { variant: 2 });
  b.poi("arcade", c + w - 4, r + 1, "up");
  // With height to spare: a meeting table, and further down a corner with a sofa.
  if (h >= 15 && w >= 12) {
    const tc = cx - 3;
    b.item("meetingTable", tc, r + 8, 6, 2);
    for (let x = tc; x < tc + 6; x += 2) {
      tableSeats(b, x, r + 8);
    }
  }
  if (h >= 22 && w >= 12) {
    sofaSeats(b, b.item("sofaDown", c + 2, r + 14, 4, 2, { variant: 1 }), "down");
    b.item("coffeeTable", c + 2, r + 17, 4, 2);
    b.item("lamp", c + 1, r + 14, 1, 1);
    b.item("plant", c + 7, r + 14, 1, 1, { variant: 0 });
    beanbag(b, c + w - 3, r + h - 3, 0);
    beanbag(b, c + w - 6, r + h - 3, 1);
    return;
  }
  beanbag(b, c + 1, r + h - 3, 1);
  if (w >= 8) {
    beanbag(b, c + w - 3, r + h - 3, 0);
  }
}
