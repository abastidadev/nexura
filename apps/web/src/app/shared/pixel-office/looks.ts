// How each character looks: picked from a hash of the run and the step, so an agent keeps
// its look across reloads. Pure (no DOM), shared by the plan, the simulation and the painter.

export type HairStyle = "short" | "spiky" | "long" | "bob" | "curly" | "bun" | "ponytail" | "bald" | "wavy";
export type Top = "tee" | "hoodie" | "shirt" | "suit";
export type Accessory = "none" | "glasses" | "sunglasses" | "headphones" | "cap" | "beanie" | "beard";

export type Look = {
  /** Cache key of the painted sprites. */
  key: string;
  robot: boolean;
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  top: Top;
  shirt: string;
  tie: string;
  pants: string;
  shoes: string;
  accessory: Accessory;
  accessoryColor: string;
  /** Colour of the flow the agent works for (lanyard, chair, robot chest light). */
  team: string;
};

/** Flow colours: lanyards, chairs, rugs and the legend. */
export const TEAM_COLORS = ["#e5534b", "#f0a030", "#e2c541", "#4fbf6a", "#3dbdc9", "#4f86f0", "#9a6cf0", "#e46fb4"] as const;

const SKINS = ["#ffdcc4", "#f5c8a0", "#e2a878", "#c68a5a", "#9c6642", "#6e4429"];
const HAIRS = ["#2a1f1a", "#4a3020", "#7a4a28", "#b0602c", "#e0b860", "#f2dea6", "#d6d6dc", "#1c1c2c"];
const FUN_HAIRS = ["#e070a8", "#5aa0e8", "#8a60d0"];
const SHIRTS = ["#e05050", "#f08a3c", "#f0c850", "#58b868", "#3cb8a8", "#4a90e0", "#7a6ae0", "#d060a0", "#f2f2f2", "#3a3a48", "#8a5a3a"];
/** GPT (Codex, Copilot) wears shirts in green tones; Gemini, hoodies in blue-violet ones. */
const GPT_SHIRTS = ["#10a37f", "#2f8f6a", "#5cc9a7", "#1f6f5c"];
const GEMINI_HOODIES = ["#4a78e8", "#7a5ae0", "#3aa0e8", "#9a6cf0"];
const SUITS = ["#2c3550", "#3a3a42", "#5a2a36", "#4a3a2a", "#2a4a3a"];
const TIES = ["#c03030", "#3060c0", "#e0a030", "#308050"];
const PANTS = ["#3a4f7a", "#2a2e3a", "#b89868", "#5a5e68", "#6a3a2a", "#2f5a8a"];
const SHOES = ["#2a2020", "#f0f0f0", "#6a3a20", "#c03030", "#3a3a3a"];
const GEAR = ["#e04848", "#303040", "#48a0e0", "#f0c040", "#58b868", "#e070a8"];
const ROBOTS = ["#b8c0cc", "#e8c050", "#e0e4ea", "#7aa0c8"];
const STYLES: HairStyle[] = ["short", "spiky", "long", "bob", "curly", "bun", "ponytail", "bald", "wavy"];
const EXTRAS: Accessory[] = ["none", "none", "none", "glasses", "beanie", "beard", "cap", "sunglasses"];

/** Signature accessory of the built-in steps, so the same role is recognisable in every flow. */
const ROLE_ACCESSORY: Record<string, Accessory> = {
  implement: "headphones",
  codeReview: "glasses",
  addressReview: "glasses",
  prReview: "glasses",
  enrich: "beanie",
  qaNotes: "cap",
};

export function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return value;
}

/** Deterministic pick: `salt` gives independent choices from the same seed. */
function pick<T>(list: readonly T[], seed: number, salt: number): T {
  return list[hash(`${seed}:${salt}`) % list.length]!;
}

export type ModelFamily = "haiku" | "sonnet" | "opus" | "gpt" | "gemini" | "other";

/** The family of any agent's model id: Claude aliases and ids (also through Copilot), GPT (Codex, Copilot) and Gemini. */
export function modelFamily(model: string | undefined): ModelFamily {
  const name = (model ?? "").toLowerCase();
  if (name.includes("haiku") || name.includes("sonnet") || name.includes("opus")) {
    return name.includes("haiku") ? "haiku" : name.includes("sonnet") ? "sonnet" : "opus";
  }
  return /gpt|codex|^o\d/.test(name) ? "gpt" : name.includes("gemini") ? "gemini" : "other";
}

export type LookInput = { seed: string; model?: string; step: string; robot: boolean; subagent: boolean; team: string };

/**
 * The model shows in the clothes (Haiku in a t-shirt, Sonnet in a hoodie or shirt, Opus in a
 * suit, GPT in a green shirt, Gemini in a blue-violet hoodie), the role in the accessory, the
 * flow in the lanyard; the rest comes from the seed.
 */
export function lookFor(input: LookInput): Look {
  const seed = hash(input.seed);
  const family = modelFamily(input.model);
  const top: Top =
    family === "opus"
      ? "suit"
      : family === "haiku"
        ? "tee"
        : family === "gpt"
          ? "shirt"
          : family === "gemini"
            ? "hoodie"
            : family === "sonnet"
              ? pick(["hoodie", "shirt"] as const, seed, 1)
              : pick(["tee", "hoodie"] as const, seed, 1);
  const palette = top === "suit" ? SUITS : family === "gpt" ? GPT_SHIRTS : family === "gemini" ? GEMINI_HOODIES : SHIRTS;
  const hairStyle = pick(STYLES, seed, 2);
  const hair = hash(`${seed}:fun`) % 13 === 0 ? pick(FUN_HAIRS, seed, 3) : pick(HAIRS, seed, 3);
  const accessory: Accessory = input.subagent ? "cap" : (ROLE_ACCESSORY[input.step] ?? pick(EXTRAS, seed, 4));
  const look: Omit<Look, "key"> = {
    robot: input.robot,
    skin: input.robot ? pick(ROBOTS, seed, 5) : pick(SKINS, seed, 5),
    hair,
    hairStyle,
    top,
    shirt: pick(palette, seed, 6),
    tie: pick(TIES, seed, 7),
    pants: pick(PANTS, seed, 8),
    shoes: pick(SHOES, seed, 9),
    accessory,
    // Subagents wear a cap in the colour of their flow.
    accessoryColor: input.subagent ? input.team : pick(GEAR, seed, 10),
    team: input.team,
  };
  return { ...look, key: Object.values(look).join("|") };
}

/**
 * One colour per flow: its hashed colour, or the next free one when two flows collide.
 * Earlier ids win, so pass them oldest first to keep colours stable.
 */
export function teamColors(ids: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<number>();
  for (const id of ids) {
    let index = hash(id) % TEAM_COLORS.length;
    for (let tries = 0; tries < TEAM_COLORS.length && used.has(index); tries++) {
      index = (index + 1) % TEAM_COLORS.length;
    }
    used.add(index);
    result.set(id, TEAM_COLORS[index]!);
  }
  return result;
}

function channels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Mix two #rrggbb colours; `amount` 0 = a, 1 = b. */
export function mix(a: string, b: string, amount: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

export const shade = (color: string, amount = 0.25): string => mix(color, "#10121a", amount);
export const light = (color: string, amount = 0.25): string => mix(color, "#ffffff", amount);
