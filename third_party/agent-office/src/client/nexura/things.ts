// nexura: every Nexura thing you can use in the office is one interactable kind, 'nexura', told apart by
// `it.nexura` ('shop', 'duck-3', 'futbolin'…). Each module registers what its things do here, by
// prefix, and index.ts hands every hint and use to the one that matches.
import type { Hint } from '../core/context';
import type { DeskKey } from '../interaction';
import type { Interactable } from '../world/types';

export interface NexuraThing {
  hint(it: Interactable): Hint;
  use(it: Interactable, key: DeskKey): void;
}

const things: [string, NexuraThing][] = [];

/** Registers what the things whose `nexura` starts with `prefix` do. */
export function nexuraThing(prefix: string, thing: NexuraThing): void {
  things.push([prefix, thing]);
}

export function thingOf(it: Interactable): NexuraThing | undefined {
  const id = it.nexura ?? '';
  return things.find(([prefix]) => id.startsWith(prefix))?.[1];
}
