// Characters painted procedurally from their Look (hair, clothes, accessory…) in three
// directions and every pose, then outlined automatically. Each combination is painted once
// into a tiny canvas and cached; the office scales it up without smoothing.
import type { AgentActivity } from "../../core/agents";
import { light, mix, shade, type Look } from "./looks";
import type { Dir } from "./office-plan";
import type { Emote, Pose } from "./office-sim";

/** Sprite canvas: a 16×24 body box with a margin for the outline and tall hair or antennas. */
export const SPRITE_W = 18;
export const SPRITE_H = 29;
/** Where the feet are inside the sprite canvas. */
export const FOOT_X = 9;
export const FOOT_Y = 28;
const OX = 1;
const OY = 4;

const OUTLINE = [23, 26, 36] as const;
const EYE = "#241c1c";
const MOUTH = "#7a3434";
const WHITE = "#f4f4f4";
const LANYARD = "#f4f4f4";

type View = "front" | "back" | "side";
type Legs = "stand" | "walkA" | "walkB" | "sit" | "none";
type Arms = "down" | "swingA" | "swingB" | "up" | "rightUp" | "forward" | "typeA" | "typeB" | "hold" | "mug" | "mugLow" | "reachSide" | "paddle";
type Eyes = "open" | "closed" | "down" | "happy";
type Mouth = "none" | "smile" | "open" | "frown";
type Held = "none" | "phone" | "book";

type Shape = { view: View; legs: Legs; arms: Arms; eyes: Eyes; mouth: Mouth; drop: number; bob: number; held: Held };

type Paint = (x: number, y: number, w: number, h: number, color: string) => void;

/** Poses that force a direction (seated at a desk faces the monitor, the sofa faces us…). */
export function poseDir(pose: Pose, dir: Dir): Dir {
  switch (pose) {
    case "work":
    case "sitBack":
    case "nap":
    case "play":
    case "reach":
      return "up";
    case "sitFront":
    case "sleep":
    case "drink":
    case "phone":
    case "book":
    case "cheer":
    case "dance":
    case "yawn":
    case "sad":
      return "down";
    default:
      return dir;
  }
}

function shapeFor(pose: Pose, dir: Dir, frame: number, activity: AgentActivity | undefined): Shape {
  const view: View = dir === "down" ? "front" : dir === "up" ? "back" : "side";
  const alt = frame % 2 === 1;
  const base: Shape = { view, legs: "stand", arms: "down", eyes: frame % 23 === 0 ? "closed" : "open", mouth: "smile", drop: 0, bob: 0, held: "none" };
  switch (pose) {
    case "walk":
      return { ...base, legs: alt ? "walkB" : "walkA", arms: alt ? "swingB" : "swingA", bob: alt ? 0 : -1 };
    case "work":
      if (activity === "blocked") {
        return { ...base, legs: "none", arms: alt ? "rightUp" : "forward" };
      }
      if (activity === "typing" || activity === "running") {
        return { ...base, legs: "none", arms: alt ? "typeA" : "typeB" };
      }
      return { ...base, legs: "none", arms: "forward", drop: activity === "reading" && frame % 8 < 4 ? 1 : 0 };
    case "sitBack":
      return { ...base, legs: "none", arms: "forward" };
    case "nap":
      return { ...base, legs: "none", arms: "forward", drop: alt ? 3 : 2 };
    case "play":
      return { ...base, arms: alt ? "typeA" : "typeB" };
    case "reach":
      return { ...base, arms: alt ? "rightUp" : "down" };
    case "sitFront":
      return { ...base, legs: "sit" };
    case "sleep":
      return { ...base, legs: "sit", eyes: "closed", mouth: "open", drop: alt ? 1 : 0 };
    case "drink":
      return { ...base, arms: Math.floor(frame / 6) % 2 ? "mugLow" : "mug", eyes: Math.floor(frame / 6) % 2 ? "open" : "closed", mouth: "none" };
    case "phone":
      return { ...base, arms: "hold", held: "phone", eyes: "down", mouth: frame % 16 < 3 ? "open" : "smile" };
    case "book":
      return { ...base, arms: "hold", held: "book", eyes: "down" };
    case "cheer":
      return { ...base, arms: "up", eyes: "happy", mouth: "open", bob: alt ? -2 : 0 };
    case "dance":
      return { ...base, legs: alt ? "walkA" : "walkB", arms: Math.floor(frame / 2) % 2 ? "up" : "rightUp", eyes: "happy", mouth: "open", bob: alt ? -1 : 0 };
    case "yawn":
      return { ...base, arms: "up", eyes: "closed", mouth: "open" };
    case "sad":
      return { ...base, eyes: "down", mouth: "frown", drop: 1 };
    case "talk":
      return { ...base, mouth: alt ? "open" : "smile", arms: view === "side" && Math.floor(frame / 3) % 2 ? "reachSide" : "down" };
    case "swing":
      return { ...base, arms: alt ? "paddle" : "reachSide", legs: alt ? "walkA" : "stand" };
    case "pet":
      return { ...base, arms: "reachSide", eyes: "happy" };
    case "stand":
      return base;
  }
}

const cache = new Map<string, HTMLCanvasElement>();

/** The sprite of a character; `dir` "left" is painted as "right" and mirrored by the caller. */
export function characterSprite(look: Look, pose: Pose, dir: Dir, frame: number, activity?: AgentActivity): HTMLCanvasElement {
  const facing = poseDir(pose, dir);
  const shape = shapeFor(pose, facing === "left" ? "right" : facing, frame, activity);
  const key = `${look.key}/${JSON.stringify(shape)}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = SPRITE_W;
    canvas.height = SPRITE_H;
    const context = canvas.getContext("2d")!;
    const paint: Paint = (x, y, w, h, color) => {
      context.fillStyle = color;
      context.fillRect(OX + x, OY + y + shape.bob, w, h);
    };
    if (look.robot) {
      paintRobot(paint, look, shape);
    } else {
      paintPerson(paint, look, shape);
    }
    outline(context);
    if (cache.size > 4000) {
      cache.clear();
    }
    cache.set(key, canvas);
  }
  return canvas;
}

/** Paints every transparent pixel that touches the figure with the outline colour. */
function outline(context: CanvasRenderingContext2D, color: readonly [number, number, number] = OUTLINE): void {
  const { width, height } = context.canvas;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3]! > 0;
  const edges: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaque(x, y) && (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1))) {
        edges.push((y * width + x) * 4);
      }
    }
  }
  for (const index of edges) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

// ── People ──────────────────────────────────────────────────────────────

function paintPerson(p: Paint, look: Look, s: Shape): void {
  const skin = look.skin;
  const skinDark = shade(skin, 0.18);
  const sleeve = look.top === "tee" ? look.shirt : shade(look.shirt, 0.22);
  paintLegs(p, look, s);
  paintTorso(p, look, s);
  paintArms(p, look, s, sleeve, skin);
  const d = s.drop;
  // Head: a big rounded block.
  p(4, 0 + d, 8, 1, skin);
  p(3, 1 + d, 10, 1, skin);
  p(2, 2 + d, 12, 7, skin);
  p(3, 9 + d, 10, 1, skin);
  p(4, 10 + d, 8, 1, skinDark);
  if (s.view !== "side") {
    p(1, 5 + d, 1, 2, skinDark);
    p(14, 5 + d, 1, 2, skinDark);
  } else {
    p(14, 6 + d, 1, 2, skin);
  }
  if (s.view === "front") {
    paintFace(p, look, s, d);
  } else if (s.view === "side") {
    paintSideFace(p, s, d);
  }
  paintHair(p, look, s, d);
  paintAccessory(p, look, s, d);
  if (s.held !== "none") {
    paintHeld(p, s);
  }
  if (s.arms === "mug") {
    // The mug goes in front of the face.
    p(12, 8, 1, 1, skin);
    p(9, 7, 3, 3, WHITE);
    p(9, 7, 3, 1, "#6a3a20");
  }
}

function paintFace(p: Paint, look: Look, s: Shape, d: number): void {
  const blush = mix(look.skin, "#ff7a7a", 0.35);
  switch (s.eyes) {
    case "open":
      p(5, 5 + d, 1, 2, EYE);
      p(10, 5 + d, 1, 2, EYE);
      break;
    case "down":
      p(5, 6 + d, 1, 2, EYE);
      p(10, 6 + d, 1, 2, EYE);
      break;
    case "closed":
      p(4, 6 + d, 2, 1, EYE);
      p(10, 6 + d, 2, 1, EYE);
      break;
    case "happy":
      p(4, 6 + d, 1, 1, EYE);
      p(5, 5 + d, 1, 1, EYE);
      p(6, 6 + d, 1, 1, EYE);
      p(9, 6 + d, 1, 1, EYE);
      p(10, 5 + d, 1, 1, EYE);
      p(11, 6 + d, 1, 1, EYE);
      break;
  }
  p(3, 7 + d, 2, 1, blush);
  p(11, 7 + d, 2, 1, blush);
  switch (s.mouth) {
    case "smile":
      p(7, 8 + d, 2, 1, shade(look.skin, 0.3));
      break;
    case "open":
      p(7, 8 + d, 2, 2, MOUTH);
      break;
    case "frown":
      p(7, 8 + d, 2, 1, MOUTH);
      p(6, 9 + d, 1, 1, MOUTH);
      p(9, 9 + d, 1, 1, MOUTH);
      break;
    case "none":
      break;
  }
}

function paintSideFace(p: Paint, s: Shape, d: number): void {
  if (s.eyes === "closed") {
    p(10, 6 + d, 2, 1, EYE);
  } else if (s.eyes === "happy") {
    p(10, 6 + d, 1, 1, EYE);
    p(11, 5 + d, 1, 1, EYE);
  } else {
    p(11, (s.eyes === "down" ? 6 : 5) + d, 1, 2, EYE);
  }
  if (s.mouth === "open") {
    p(12, 8 + d, 2, 2, MOUTH);
  } else if (s.mouth !== "none") {
    p(12, 8 + d, 2, 1, MOUTH);
  }
}

function paintTorso(p: Paint, look: Look, s: Shape): void {
  const shirt = look.shirt;
  const dark = shade(shirt, 0.22);
  const side = s.view === "side";
  const x = side ? 5 : 4;
  const w = side ? 6 : 8;
  p(x, 11, w, 6, shirt);
  p(x, 17, w, 1, shade(look.pants, 0.25));
  if (s.view === "back") {
    if (look.top === "hoodie") {
      p(5, 11, 6, 2, dark);
    } else if (look.top === "suit") {
      p(7, 13, 2, 4, dark);
    } else if (look.top === "shirt") {
      p(5, 11, 6, 1, light(shirt, 0.4));
    }
    p(6, 11, 4, 1, look.team);
    return;
  }
  if (side) {
    if (look.top === "suit") {
      p(9, 11, 2, 5, WHITE);
      p(10, 12, 1, 4, look.tie);
    } else if (look.top === "hoodie") {
      p(4, 11, 2, 2, dark);
    }
    p(9, 11, 1, 2, look.team);
    p(9, 13, 2, 2, LANYARD);
    return;
  }
  switch (look.top) {
    case "tee":
      p(7, 11, 2, 1, look.skin);
      break;
    case "hoodie":
      p(4, 11, 8, 1, dark);
      p(6, 12, 1, 2, WHITE);
      p(9, 12, 1, 2, WHITE);
      p(5, 15, 6, 2, dark);
      break;
    case "shirt":
      p(5, 11, 2, 1, WHITE);
      p(9, 11, 2, 1, WHITE);
      p(7, 11, 2, 1, look.skin);
      p(8, 13, 1, 1, dark);
      p(8, 15, 1, 1, dark);
      break;
    case "suit":
      p(6, 11, 4, 5, WHITE);
      p(7, 11, 2, 5, look.tie);
      p(7, 11, 2, 1, shade(look.tie, 0.3));
      p(5, 11, 1, 3, dark);
      p(10, 11, 1, 3, dark);
      break;
  }
  // Lanyard and badge in the flow's colour.
  p(5, 11, 1, 2, look.team);
  p(10, 11, 1, 2, look.team);
  p(6, 13, 1, 1, look.team);
  p(9, 13, 1, 1, look.team);
  p(7, 14, 2, 2, LANYARD);
  p(7, 14, 2, 1, look.team);
}

function paintArms(p: Paint, look: Look, s: Shape, sleeve: string, skin: string): void {
  const bare = look.top === "tee";
  // A down arm: sleeve on top, then skin (bare arms in a t-shirt), then the hand.
  const arm = (x: number, y: number, h: number): void => {
    if (bare) {
      p(x, y, 2, 2, sleeve);
      p(x, y + 2, 2, h - 2, skin);
    } else {
      p(x, y, 2, h - 1, sleeve);
      p(x, y + h - 1, 2, 1, skin);
    }
  };
  const raised = (x: number): void => {
    p(x, 3, 2, 1, skin);
    p(x, 4, 2, 8, bare ? skin : sleeve);
    p(x, 10, 2, 2, sleeve);
  };
  if (s.view === "side") {
    switch (s.arms) {
      case "swingA":
        p(8, 11, 3, 3, sleeve);
        p(10, 14, 2, 2, bare ? skin : sleeve);
        p(11, 16, 2, 1, skin);
        return;
      case "swingB":
        p(5, 11, 3, 3, sleeve);
        p(4, 14, 2, 2, bare ? skin : sleeve);
        p(3, 16, 2, 1, skin);
        return;
      case "reachSide":
        p(8, 11, 3, 2, sleeve);
        p(10, 13, 4, 2, bare ? skin : sleeve);
        p(14, 13, 1, 2, skin);
        return;
      case "paddle":
        p(8, 11, 3, 2, sleeve);
        p(10, 11, 3, 2, bare ? skin : sleeve);
        p(13, 10, 1, 2, skin);
        p(14, 8, 2, 3, "#d04040");
        p(14, 11, 1, 2, "#8a5a3a");
        return;
      case "up":
      case "rightUp":
        p(8, 4, 2, 8, bare ? skin : sleeve);
        p(8, 3, 2, 1, skin);
        return;
      default:
        p(7, 11, 3, 5, sleeve);
        if (bare) {
          p(7, 13, 3, 3, skin);
        }
        p(7, 16, 3, 1, skin);
        return;
    }
  }
  switch (s.arms) {
    case "down":
      arm(2, 11, 6);
      arm(12, 11, 6);
      return;
    case "swingA":
      arm(2, 12, 6);
      arm(12, 10, 6);
      return;
    case "swingB":
      arm(2, 10, 6);
      arm(12, 12, 6);
      return;
    case "up":
      raised(0);
      raised(14);
      p(2, 11, 2, 1, sleeve);
      p(12, 11, 2, 1, sleeve);
      return;
    case "rightUp":
      arm(2, 11, 6);
      raised(14);
      p(12, 11, 2, 1, sleeve);
      return;
    case "forward":
      p(2, 11, 2, 3, sleeve);
      p(12, 11, 2, 3, sleeve);
      return;
    case "typeA":
      p(2, 11, 2, 3, sleeve);
      p(12, 11, 2, 2, sleeve);
      p(12, 13, 2, 1, skin);
      return;
    case "typeB":
      p(2, 11, 2, 2, sleeve);
      p(2, 13, 2, 1, skin);
      p(12, 11, 2, 3, sleeve);
      return;
    case "hold":
      p(2, 11, 2, 3, sleeve);
      p(12, 11, 2, 3, sleeve);
      p(3, 14, 3, 1, bare ? skin : sleeve);
      p(10, 14, 3, 1, bare ? skin : sleeve);
      p(6, 14, 1, 1, skin);
      p(9, 14, 1, 1, skin);
      return;
    case "mug":
      arm(2, 11, 6);
      p(12, 11, 2, 2, sleeve);
      p(12, 9, 2, 2, bare ? skin : sleeve);
      p(12, 8, 1, 1, skin);
      p(9, 7, 3, 3, WHITE);
      p(9, 7, 3, 1, "#6a3a20");
      return;
    case "mugLow":
      arm(2, 11, 6);
      arm(12, 11, 5);
      p(12, 14, 3, 3, WHITE);
      p(12, 14, 3, 1, "#6a3a20");
      return;
    case "reachSide":
    case "paddle":
      arm(2, 11, 6);
      p(12, 11, 2, 2, sleeve);
      p(12, 13, 3, 1, bare ? skin : sleeve);
      p(14, 12, 1, 2, skin);
      return;
  }
}

function paintLegs(p: Paint, look: Look, s: Shape): void {
  const pants = look.pants;
  const dark = shade(pants, 0.2);
  const shoes = look.shoes;
  if (s.view === "side") {
    switch (s.legs) {
      case "walkA":
        p(7, 18, 3, 2, pants);
        p(9, 20, 3, 2, pants);
        p(9, 22, 4, 2, shoes);
        p(5, 18, 3, 2, dark);
        p(4, 20, 3, 2, dark);
        p(3, 22, 3, 2, shade(shoes, 0.2));
        return;
      case "walkB":
        p(6, 18, 4, 4, pants);
        p(6, 22, 5, 2, shoes);
        return;
      case "sit":
        p(5, 18, 7, 2, pants);
        p(10, 20, 2, 2, pants);
        p(10, 22, 4, 1, shoes);
        return;
      case "none":
        return;
      default:
        p(5, 18, 6, 4, pants);
        p(8, 18, 1, 4, dark);
        p(5, 22, 7, 2, shoes);
        return;
    }
  }
  const leg = (x: number, lift: number): void => {
    p(x, 18, 3, 4 - lift, pants);
    p(x, 22 - lift, 3, 2, shoes);
  };
  switch (s.legs) {
    case "stand":
      p(4, 18, 8, 2, pants);
      leg(4, 0);
      leg(9, 0);
      p(7, 18, 2, 2, pants);
      return;
    case "walkA":
      p(4, 18, 8, 2, pants);
      leg(4, 1);
      leg(9, 0);
      return;
    case "walkB":
      p(4, 18, 8, 2, pants);
      leg(4, 0);
      leg(9, 1);
      return;
    case "sit":
      p(4, 18, 8, 2, light(pants, 0.12));
      p(4, 20, 3, 1, pants);
      p(9, 20, 3, 1, pants);
      p(4, 21, 3, 1, shoes);
      p(9, 21, 3, 1, shoes);
      return;
    case "none":
      return;
  }
}

function paintHair(p: Paint, look: Look, s: Shape, d: number): void {
  const h = look.hair;
  const hs = shade(h, 0.28);
  const hl = light(h, 0.25);
  const r = (x: number, y: number, w: number, hh: number, color = h): void => p(x, y + d, w, hh, color);
  const view = s.view;
  const top = (): void => {
    r(3, -1, 10, 1);
    r(2, 0, 12, 4);
    r(4, 0, 3, 1, hl);
  };
  const back = (): void => {
    r(3, -1, 10, 1);
    r(2, 0, 12, 9);
    r(3, 9, 10, 1, hs);
    r(4, 0, 3, 1, hl);
  };
  const sideTop = (): void => {
    r(3, -1, 9, 1);
    r(2, 0, 12, 4);
    r(2, 4, 5, 4);
    r(2, 8, 4, 1, hs);
    r(12, 4, 1, 1);
    r(5, 0, 4, 1, hl);
  };
  switch (look.hairStyle) {
    case "short":
      if (view === "front") {
        top();
        r(2, 4, 2, 2);
        r(12, 4, 2, 2);
        r(4, 4, 3, 1);
        r(9, 4, 2, 1);
      } else if (view === "back") {
        back();
      } else {
        sideTop();
      }
      return;
    case "spiky":
      r(3, -3, 2, 2);
      r(7, -4, 2, 3);
      r(11, -3, 2, 2);
      if (view === "front") {
        top();
        r(2, 4, 2, 2);
        r(12, 4, 2, 2);
        r(4, 4, 1, 2);
        r(7, 4, 1, 1);
        r(10, 4, 1, 2);
      } else if (view === "back") {
        back();
      } else {
        sideTop();
        r(12, 4, 2, 2);
      }
      return;
    case "long":
    case "wavy": {
      const wavy = look.hairStyle === "wavy";
      if (view === "front") {
        top();
        r(wavy ? 0 : 1, 2, wavy ? 3 : 2, 12);
        r(13, 2, wavy ? 3 : 2, 12);
        r(3, 4, 3, 1);
        r(10, 4, 3, 1);
        r(1, 12, 2, 2, hs);
        r(13, 12, 2, 2, hs);
        if (wavy) {
          for (const [x, y] of [[1, 5], [2, 8], [1, 11], [14, 6], [13, 9], [14, 12]] as const) {
            r(x, y, 1, 1, hs);
          }
          r(1, 3, 1, 1, hl);
          r(14, 3, 1, 1, hl);
        }
      } else if (view === "back") {
        back();
        r(wavy ? 1 : 2, 9, wavy ? 14 : 12, 5);
        r(3, 14, 10, 1, hs);
        if (wavy) {
          for (const [x, y] of [[3, 5], [7, 8], [11, 6], [5, 11], [10, 12]] as const) {
            r(x, y, 1, 1, hs);
          }
        }
      } else {
        sideTop();
        r(wavy ? 0 : 1, 3, 6, 11);
        r(1, 13, 5, 1, hs);
        if (wavy) {
          r(2, 7, 1, 1, hs);
          r(3, 10, 1, 1, hs);
        }
      }
      return;
    }
    case "bob":
      if (view === "front") {
        top();
        r(1, 2, 2, 8);
        r(13, 2, 2, 8);
        r(3, 4, 10, 1);
        r(1, 9, 2, 1, hs);
        r(13, 9, 2, 1, hs);
      } else if (view === "back") {
        back();
        r(1, 2, 1, 8);
        r(14, 2, 1, 8);
      } else {
        sideTop();
        r(1, 3, 7, 7);
        r(11, 4, 2, 1);
      }
      return;
    case "curly": {
      const dots: [number, number][] = [[3, -2], [8, -1], [12, -2], [1, 2], [14, 3], [5, 1], [10, 2]];
      r(2, -4, 3, 1);
      r(6, -4, 4, 1);
      r(11, -4, 3, 1);
      r(1, -3, 14, 3);
      if (view === "front") {
        r(0, 0, 16, 4);
        r(0, 4, 3, 5);
        r(13, 4, 3, 5);
        r(3, 4, 2, 1);
        r(11, 4, 2, 1);
      } else if (view === "back") {
        r(0, 0, 16, 10);
        dots.push([4, 6], [9, 7], [12, 5]);
      } else {
        r(0, 0, 15, 4);
        r(0, 4, 8, 6);
        r(12, 4, 2, 1);
      }
      for (const [x, y] of dots) {
        r(x, y, 1, 1, hs);
      }
      r(4, -3, 1, 1, hl);
      r(9, -3, 1, 1, hl);
      return;
    }
    case "bun":
      r(5, -4, 6, 3);
      r(6, -4, 2, 1, hl);
      if (view === "front") {
        top();
        r(2, 4, 1, 3);
        r(13, 4, 1, 3);
        r(4, 4, 3, 1);
      } else if (view === "back") {
        back();
        r(6, -1, 4, 1, look.accessoryColor);
      } else {
        sideTop();
      }
      return;
    case "ponytail":
      if (view === "front") {
        top();
        r(2, 4, 1, 4);
        r(13, 4, 1, 4);
        r(4, 4, 4, 1);
        r(14, 6, 1, 6, hs);
      } else if (view === "back") {
        back();
        r(6, 9, 4, 6);
        r(6, 9, 4, 1, look.accessoryColor);
        r(7, 14, 2, 1, hs);
      } else {
        sideTop();
        r(0, 4, 3, 8);
        r(2, 4, 1, 2, look.accessoryColor);
        r(0, 11, 2, 1, hs);
      }
      return;
    case "bald":
      if (view === "front") {
        r(2, 3, 1, 4);
        r(13, 3, 1, 4);
        r(5, 1, 3, 1, light(look.skin, 0.35));
      } else if (view === "back") {
        r(2, 5, 12, 4);
        r(3, 9, 10, 1, hs);
        r(6, 1, 3, 1, light(look.skin, 0.35));
      } else {
        r(2, 3, 4, 5);
        r(8, 1, 3, 1, light(look.skin, 0.35));
      }
      return;
  }
}

function paintAccessory(p: Paint, look: Look, s: Shape, d: number): void {
  const a = look.accessoryColor;
  const as = shade(a, 0.3);
  const r = (x: number, y: number, w: number, h: number, color = a): void => p(x, y + d, w, h, color);
  const view = s.view;
  switch (look.accessory) {
    case "glasses":
    case "sunglasses": {
      const lens = look.accessory === "sunglasses" ? "#1a1a24" : "#d8f0ff";
      const frame = "#1e1e28";
      if (view === "front") {
        r(4, 5, 3, 2, lens);
        r(9, 5, 3, 2, lens);
        r(4, 4, 3, 1, frame);
        r(9, 4, 3, 1, frame);
        r(7, 5, 2, 1, frame);
        r(3, 5, 1, 1, frame);
        r(12, 5, 1, 1, frame);
        if (look.accessory === "glasses" && s.eyes !== "closed") {
          r(5, 6, 1, 1, EYE);
          r(10, 6, 1, 1, EYE);
        } else if (look.accessory === "sunglasses") {
          r(4, 5, 1, 1, "#8a8aa0");
          r(9, 5, 1, 1, "#8a8aa0");
        }
      } else if (view === "side") {
        r(10, 5, 3, 2, lens);
        r(10, 4, 3, 1, frame);
        r(7, 5, 3, 1, frame);
        if (look.accessory === "glasses") {
          r(11, 6, 1, 1, EYE);
        }
      } else {
        r(1, 5, 1, 1, frame);
        r(14, 5, 1, 1, frame);
      }
      return;
    }
    case "headphones":
      if (view === "side") {
        r(3, -2, 9, 1);
        r(6, 3, 3, 5);
        r(6, 7, 3, 1, as);
      } else {
        r(3, -2, 10, 1);
        r(1, -1, 1, 3);
        r(14, -1, 1, 3);
        r(0, 3, 2, 5);
        r(14, 3, 2, 5);
        r(0, 7, 2, 1, as);
        r(14, 7, 2, 1, as);
      }
      return;
    case "cap":
      r(2, -2, 12, 4);
      r(7, -2, 2, 1, light(a, 0.3));
      if (view === "front") {
        r(1, 2, 14, 1, as);
      } else if (view === "side") {
        r(10, 2, 5, 1, as);
      } else {
        r(6, 1, 4, 1, as);
      }
      return;
    case "beanie":
      r(2, -2, 12, 4);
      r(2, 2, 12, 2, as);
      for (let x = 3; x < 14; x += 2) {
        r(x, 2, 1, 2, a);
      }
      r(7, -4, 2, 2, light(a, 0.4));
      return;
    case "beard":
      if (view === "front") {
        r(3, 7, 10, 3, look.hair);
        r(4, 10, 8, 1, look.hair);
        r(7, 8, 2, 1, s.mouth === "open" ? MOUTH : shade(look.hair, 0.3));
      } else if (view === "side") {
        r(7, 7, 7, 3, look.hair);
        r(8, 10, 5, 1, look.hair);
      }
      return;
    case "none":
      return;
  }
}

function paintHeld(p: Paint, s: Shape): void {
  if (s.held === "phone") {
    p(7, 12, 2, 3, "#22222c");
    p(7, 12, 2, 2, "#7fd8ff");
  } else {
    p(4, 12, 8, 3, "#b03a3a");
    p(5, 12, 3, 2, "#f4efe0");
    p(8, 12, 3, 2, "#f4efe0");
  }
}

// ── Robots (steps without an LLM) ───────────────────────────────────────

function paintRobot(p: Paint, look: Look, s: Shape): void {
  const metal = look.skin;
  const dark = shade(metal, 0.3);
  const darker = shade(metal, 0.5);
  const visor = "#1a2030";
  const glow = "#5fe3ff";
  const d = s.drop;
  // Legs and feet.
  if (s.legs !== "none") {
    const lift = (left: boolean): number => (s.legs === "walkA" && left) || (s.legs === "walkB" && !left) ? 1 : 0;
    if (s.legs === "sit") {
      p(4, 18, 8, 2, dark);
      p(4, 20, 3, 2, darker);
      p(9, 20, 3, 2, darker);
    } else if (s.view === "side") {
      p(6, 18, 4, 4, dark);
      p(6, 22, 6, 2, darker);
    } else {
      p(5, 18, 2, 4 - lift(true), dark);
      p(9, 18, 2, 4 - lift(false), dark);
      p(4, 22 - lift(true), 4, 2, darker);
      p(8, 22 - lift(false), 4, 2, darker);
    }
  }
  // Body with a chest panel whose light is the flow's colour.
  p(3, 11, 10, 7, metal);
  p(3, 17, 10, 1, dark);
  if (s.view === "front") {
    p(5, 12, 6, 4, visor);
    p(6, 13, 1, 1, "#ff5050");
    p(8, 13, 1, 1, "#50ff80");
    p(6, 15, 4, 1, look.team);
  } else if (s.view === "back") {
    p(5, 12, 6, 1, dark);
    p(5, 14, 6, 1, dark);
    p(6, 11, 4, 1, look.team);
  } else {
    p(9, 12, 3, 4, visor);
    p(10, 13, 1, 1, look.team);
  }
  // Arms.
  const arm = (x: number, y: number, h: number): void => {
    p(x, y, 2, h, dark);
    p(x, y + h, 2, 1, darker);
  };
  if (s.view === "side") {
    if (s.arms === "reachSide" || s.arms === "paddle") {
      p(8, 12, 6, 2, dark);
      p(14, 12, 1, 2, darker);
    } else {
      arm(7, 11, 5);
    }
  } else if (s.arms === "up") {
    arm(0, 3, 8);
    arm(14, 3, 8);
  } else if (s.arms === "rightUp") {
    arm(1, 11, 5);
    arm(14, 3, 8);
  } else if (s.arms === "forward" || s.arms === "typeA" || s.arms === "typeB" || s.arms === "hold") {
    arm(1, 11, s.arms === "typeA" ? 2 : 3);
    arm(13, 11, s.arms === "typeB" ? 2 : 3);
  } else {
    arm(1, 11 + (s.arms === "swingA" ? 1 : 0), 5);
    arm(13, 11 + (s.arms === "swingB" ? 1 : 0), 5);
  }
  // Square head with an antenna.
  p(7, -3 + d, 2, 3, darker);
  p(7, -4 + d, 2, 1, "#ff5050");
  p(3, 0 + d, 10, 1, metal);
  p(2, 1 + d, 12, 9, metal);
  p(2, 9 + d, 12, 1, dark);
  p(3, 10 + d, 10, 1, darker);
  const asleep = s.eyes === "closed";
  if (s.view === "front") {
    p(3, 3 + d, 10, 4, visor);
    if (asleep) {
      p(5, 5 + d, 2, 1, shade(glow, 0.5));
      p(9, 5 + d, 2, 1, shade(glow, 0.5));
    } else if (s.eyes === "happy") {
      p(5, 4 + d, 2, 1, glow);
      p(9, 4 + d, 2, 1, glow);
    } else {
      p(5, (s.eyes === "down" ? 5 : 4) + d, 2, 2, glow);
      p(9, (s.eyes === "down" ? 5 : 4) + d, 2, 2, glow);
    }
    p(6, 8 + d, 4, 1, s.mouth === "open" ? glow : dark);
  } else if (s.view === "side") {
    p(9, 3 + d, 5, 4, visor);
    p(11, 4 + d, 2, asleep ? 1 : 2, asleep ? shade(glow, 0.5) : glow);
    p(4, 4 + d, 3, 3, dark);
  } else {
    p(5, 3 + d, 6, 4, dark);
    p(6, 4 + d, 4, 1, darker);
    p(6, 6 + d, 4, 1, darker);
  }
  if (s.held !== "none") {
    paintHeld(p, s);
  }
}

// ── The office cat ──────────────────────────────────────────────────────

export const CAT_W = 14;
export const CAT_H = 12;

const FUR = "#e8913a";
const FUR_DARK = "#c46f24";
const STRIPE = "#b35f1c";
const BELLY = "#fbe3c2";
const CAT_EYE = "#3a2410";
const CAT_NOSE = "#e87080";
/** A warm brown outline reads better on orange fur than the near-black one of the people. */
const CAT_OUTLINE = [92, 48, 20] as const;

export function catSprite(pose: "walk" | "sit" | "sleep", frame: number): HTMLCanvasElement {
  const phase = pose === "walk" ? frame % 2 : pose === "sleep" ? Math.floor(frame / 6) % 2 : Math.floor(frame / 10) % 2;
  const key = `cat/${pose}/${phase}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = CAT_W;
    canvas.height = CAT_H;
    const context = canvas.getContext("2d")!;
    const p: Paint = (x, y, w, h, color) => {
      context.fillStyle = color;
      context.fillRect(1 + x, 1 + y, w, h);
    };
    const alt = phase === 1;
    if (pose === "sleep") {
      // Curled up in a ball, head on the left with its ears up, tail wrapped in front; breathing.
      p(4, alt ? 4 : 3, 6, 1, FUR);
      p(3, 4, 8, 4, FUR);
      p(4, 8, 6, 1, FUR_DARK);
      p(6, alt ? 4 : 3, 1, 2, STRIPE);
      p(8, 4, 1, 2, STRIPE);
      p(10, 5, 1, 1, STRIPE);
      p(0, 4, 4, 4, FUR);
      p(0, 3, 1, 1, FUR);
      p(3, 3, 1, 1, FUR);
      p(1, 5, 2, 1, CAT_EYE);
      p(0, 6, 1, 1, CAT_NOSE);
      p(1, 6, 2, 1, BELLY);
      p(4, 7, 7, 1, STRIPE);
    } else if (pose === "sit") {
      // Sitting towards us, tail around the paws.
      p(3, 1, 6, 4, FUR);
      p(3, 0, 1, 1, FUR);
      p(8, 0, 1, 1, FUR);
      p(5, 1, 2, 1, STRIPE);
      p(4, 2, 1, 1, alt ? STRIPE : CAT_EYE);
      p(7, 2, 1, 1, alt ? STRIPE : CAT_EYE);
      p(5, 3, 2, 1, CAT_NOSE);
      p(3, 5, 6, 4, FUR);
      p(4, 6, 4, 3, BELLY);
      p(3, 5, 1, 2, STRIPE);
      p(8, 5, 1, 2, STRIPE);
      p(4, 8, 1, 1, "#ffffff");
      p(7, 8, 1, 1, "#ffffff");
      p(9, 7, 2, 2, FUR);
      p(10, 6, 1, 1, FUR);
      p(9, 8, 1, 1, STRIPE);
    } else {
      // Walking to the right, tail up.
      p(1, 1, 1, 3, FUR);
      p(0, 0, 1, 2, FUR);
      p(2, 4, 8, 3, FUR);
      p(4, 4, 1, 2, STRIPE);
      p(6, 4, 1, 2, STRIPE);
      p(3, 6, 6, 1, BELLY);
      p(8, 1, 4, 4, FUR);
      p(8, 0, 1, 1, FUR);
      p(11, 0, 1, 1, FUR);
      p(9, 1, 1, 1, STRIPE);
      p(10, 2, 1, 1, CAT_EYE);
      p(11, 3, 1, 1, CAT_NOSE);
      const legs = alt ? [2, 5, 7, 9] : [3, 4, 8, 9];
      for (const x of legs) {
        p(x, 7, 1, 2, x === 3 || x === 2 ? FUR_DARK : FUR);
      }
    }
    outline(context, CAT_OUTLINE);
    cache.set(key, canvas);
  }
  return canvas;
}

// ── Emotes ──────────────────────────────────────────────────────────────

const EMOTE_COLORS: Record<string, string> = {
  k: "#2a2a36",
  r: "#e04848",
  y: "#f0c83c",
  w: "#ffffff",
  b: "#4a90e0",
  g: "#9aa0ac",
  o: "#b8742f",
  n: "#6a3a20",
  G: "#48b060",
  p: "#e070a8",
  c: "#5fb8e8",
};

/** 7×7 icons drawn inside a speech bubble ('.' transparent). */
export const EMOTES: Record<Emote, string[]> = {
  zzz: [],
  cloud: [],
  dots: [".......", ".......", ".......", ".k.k.k.", ".......", ".......", "......."],
  heart: [".......", ".rr.rr.", "rrrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."],
  note: ["...kk..", "...k.k.", "...k..k", "...k...", ".kkk...", "kkkk...", ".kk...."],
  idea: ["..yyy..", ".yyyyy.", ".yywyy.", ".yyyyy.", "..yyy..", "..ggg..", "..ggg.."],
  question: ["..bbb..", ".b...b.", ".....b.", "...bb..", "...b...", ".......", "...b..."],
  bang: ["...r...", "...r...", "...r...", "...r...", "...r...", ".......", "...r..."],
  coffee: ["..g.g..", "...g...", ".wwwww.", ".wnnnww", ".wwwwww", ".wwwww.", "..www.."],
  bug: ["k.....k", ".k.G.k.", "..GGG..", ".GkGkG.", "kGGGGGk", ".GGGGG.", "k..G..k"],
  happy: ["..yyy..", ".yyyyy.", "yykykyy", "yyyyyyy", "ykyyyky", ".ykkky.", "..yyy.."],
  star: ["...y...", "...y...", "yyyyyyy", ".yyyyy.", "..yyy..", ".yy.yy.", "y.....y"],
  arrow: ["...b...", "...bb..", "bbbbbbb", "bbbbbbb", "...bb..", "...b...", "......."],
  check: [".......", "......G", ".....GG", "G...GG.", "GG.GG..", ".GGG...", "..G...."],
  sweat: ["...c...", "..ccc..", ".ccccc.", ".ccwcc.", ".ccccc.", "..ccc..", "......."],
};

export function emoteSprite(kind: Emote): HTMLCanvasElement {
  const key = `emote/${kind}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = 11;
    canvas.height = 12;
    const context = canvas.getContext("2d")!;
    // Bubble with a little tail pointing down-left.
    context.fillStyle = "#2a2a36";
    context.fillRect(1, 0, 9, 1);
    context.fillRect(0, 1, 11, 8);
    context.fillRect(1, 9, 9, 1);
    context.fillRect(2, 10, 3, 1);
    context.fillRect(2, 11, 1, 1);
    context.fillStyle = "#ffffff";
    context.fillRect(1, 1, 9, 8);
    context.fillRect(3, 9, 2, 1);
    EMOTES[kind].forEach((row, y) =>
      [...row].forEach((cell, x) => {
        const color = EMOTE_COLORS[cell];
        if (color) {
          context.fillStyle = color;
          context.fillRect(2 + x, 1 + y, 1, 1);
        }
      }),
    );
    cache.set(key, canvas);
  }
  return canvas;
}
