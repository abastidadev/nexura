// Pixel-art sprites as character matrices (16×24), composed from head/torso/legs parts.
// '.' is transparent; every other character is a key of the palette.

export type Palette = Record<string, string>;

export type FrameName =
  | "idle"
  | "walk1"
  | "walk2"
  | "type1"
  | "type2"
  | "read1"
  | "read2"
  | "think"
  | "sleep"
  | "cheer"
  | "error";

export const SPRITE_W = 16;
export const SPRITE_H = 24;

const HEAD = [
  "................",
  ".....kkkkkk.....",
  "....khhhhhhk....",
  "...khhhhhhhhk...",
  "...khsssssshk...",
  "...ksessssesk...",
  "...kssssssssk...",
  "...ksssmmsssk...",
  "....kssssssk....",
  ".....kkkkkk.....",
];

const HEAD_SLEEP = [
  "................",
  ".....kkkkkk.....",
  "....khhhhhhk....",
  "...khhhhhhhhk...",
  "...khsssssshk...",
  "...kssssssssk...",
  "...kseesseesk...",
  "...ksssmmsssk...",
  "....kssssssk....",
  ".....kkkkkk.....",
];

const HEAD_ROBOT = [
  "........k.......",
  "........k.......",
  "....kkkkkkkk....",
  "...kggggggggk...",
  "...kgllggllgk...",
  "...kgllggllgk...",
  "...kggggggggk...",
  "...kgGGGGGGgk...",
  "...kggggggggk...",
  "....kkkkkkkk....",
];

const TORSO_DOWN = [
  "...kcccccccck...",
  "..kdccccccccdk..",
  "..kdccccccccdk..",
  "..kdccccccccdk..",
  "..ksccccccccsk..",
  "...kppppppppk...",
];

const TORSO_TYPE1 = [
  "...kcccccccck...",
  "..kdccccccccdk..",
  "..kdccccccccdk..",
  "..ksccccccccdk..",
  "...kccccccccsk..",
  "...kppppppppk...",
];

const TORSO_TYPE2 = [
  "...kcccccccck...",
  "..kdccccccccdk..",
  "..kdccccccccdk..",
  "..kdccccccccsk..",
  "..kscccccccck...",
  "...kppppppppk...",
];

const TORSO_READ1 = [
  "...kcccccccck...",
  "..kdccccccccdk..",
  "..kdcbbbbbbcdk..",
  "..ksbwkwwwwbsk..",
  "..kdbwwwkwwbdk..",
  "...kppppppppk...",
];

const TORSO_READ2 = [
  "...kcccccccck...",
  "..kdccccccccdk..",
  "..kdcbbbbbbcdk..",
  "..ksbwwwwkwbsk..",
  "..kdbwkwwwwbdk..",
  "...kppppppppk...",
];

const TORSO_CHEER = [
  "..ksccccccccsk..",
  "..kdccccccccdk..",
  "...kcccccccck...",
  "...kcccccccck...",
  "...kcccccccck...",
  "...kppppppppk...",
];

const LEGS_STAND = [
  "...kppppppppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...koookkoook...",
  "...kkkkkkkkkk...",
];

const LEGS_WALK1 = [
  "...kppppppppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkoook...",
  "...kpppkkkkkk...",
  "...koook........",
  "...kkkkk........",
];

const LEGS_WALK2 = [
  "...kppppppppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...kpppkkpppk...",
  "...koookkpppk...",
  "...kkkkkkpppk...",
  "........koook...",
  "........kkkkk...",
];

function frames(head: string[], sleepHead: string[]): Record<FrameName, string[]> {
  return {
    idle: [...head, ...TORSO_DOWN, ...LEGS_STAND],
    walk1: [...head, ...TORSO_DOWN, ...LEGS_WALK1],
    walk2: [...head, ...TORSO_DOWN, ...LEGS_WALK2],
    type1: [...head, ...TORSO_TYPE1, ...LEGS_STAND],
    type2: [...head, ...TORSO_TYPE2, ...LEGS_STAND],
    read1: [...head, ...TORSO_READ1, ...LEGS_STAND],
    read2: [...head, ...TORSO_READ2, ...LEGS_STAND],
    think: [...head, ...TORSO_DOWN, ...LEGS_STAND],
    sleep: [...sleepHead, ...TORSO_DOWN, ...LEGS_STAND],
    cheer: [...head, ...TORSO_CHEER, ...LEGS_STAND],
    error: [...head, ...TORSO_DOWN, ...LEGS_STAND],
  };
}

export const PERSON_FRAMES = frames(HEAD, HEAD_SLEEP);
export const ROBOT_FRAMES = frames(HEAD_ROBOT, HEAD_ROBOT);

/** Small icons drawn over the head; 'x' takes the icon colour. */
export const ICONS = {
  sleep: ["xxxx", "..x.", ".x..", "xxxx"],
  alert: ["xx", "xx", "xx", "xx", "..", "xx"],
  check: ["......x", ".....xx", "x...xx.", "xx.xx..", ".xxx...", "..x...."],
  pause: ["xx.xx", "xx.xx", "xx.xx", "xx.xx", "xx.xx"],
  arrow: ["..x..", "...x.", "xxxxx", "...x.", "..x.."],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

const OUTLINE = "#1a1d26";
const BASE: Palette = {
  k: OUTLINE,
  e: OUTLINE,
  m: "#b5635a",
  p: "#3a4256",
  o: "#1e2230",
  b: "#c0392b",
  w: "#f4f1e8",
};

/** Shirt colours by model: haiku / sonnet / opus / other. */
export const MODEL_SHIRTS: Record<string, [string, string]> = {
  haiku: ["#3fb8a0", "#2a8a78"],
  sonnet: ["#4f8ff0", "#3569c0"],
  opus: ["#a07cff", "#7356d8"],
  other: ["#e39a4b", "#b8742f"],
};

const SKINS = ["#f2c9a0", "#e0a878", "#c68a5a", "#8d5a3b"];
const HAIRS = ["#3b2a20", "#6b4226", "#d9b36a", "#2a2a35", "#a0522d", "#1f1a17"];

function hash(text: string): number {
  let value = 0;
  for (const char of text) {
    value = (value * 31 + char.charCodeAt(0)) >>> 0;
  }
  return value;
}

export function modelFamily(model: string | undefined): string {
  const name = (model ?? "").toLowerCase();
  return name.includes("haiku") ? "haiku" : name.includes("sonnet") ? "sonnet" : name.includes("opus") ? "opus" : "other";
}

/** Shirt by model; skin and hair picked from the seed so each step keeps its look. */
export function personPalette(model: string | undefined, seed: string): Palette {
  const [shirt, shade] = MODEL_SHIRTS[modelFamily(model)]!;
  const value = hash(seed);
  return { ...BASE, c: shirt, d: shade, s: SKINS[value % SKINS.length]!, h: HAIRS[(value >> 3) % HAIRS.length]! };
}

export const ROBOT_PALETTE: Palette = {
  ...BASE,
  c: "#aab4c3",
  d: "#7d8898",
  s: "#6f7a8a",
  g: "#c4ccd8",
  G: "#6f7a8a",
  l: "#5fe3ff",
  p: "#6f7a8a",
  o: OUTLINE,
};

const cache = new Map<string, HTMLCanvasElement>();

/** A matrix rendered once at 1 px per cell; the office scales it up without smoothing. */
export function spriteCanvas(matrix: readonly string[], palette: Palette, cacheKey: string): HTMLCanvasElement {
  let canvas = cache.get(cacheKey);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = Math.max(...matrix.map((row) => row.length));
    canvas.height = matrix.length;
    const context = canvas.getContext("2d")!;
    matrix.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        const color = palette[cell];
        if (cell !== "." && color) {
          context.fillStyle = color;
          context.fillRect(x, y, 1, 1);
        }
      });
    });
    cache.set(cacheKey, canvas);
  }
  return canvas;
}
