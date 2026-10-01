// nexura: Nexura's hooks in workers/manager.ts, from one module so they cost that file one import line
// (it is at its ceiling in tests/size.test.ts).
import { nexuraAzureNote, nexuraClaudeArgs } from './pulls.js';
export { windowsSpawn } from '../windows-command.js';

/** A Claude worker's arguments, plus on an Azure DevOps floor (`dir`) how gh translates to az (see pulls.ts). */
export function withNexuraArgs(args: string[], provider: string, dir: string): string[] {
  return provider === 'claude' ? [...args, ...nexuraClaudeArgs(dir)] : args;
}

/**
 * The first prompt of an agent that isn't Claude, with the Azure DevOps note ahead of it on an Azure
 * DevOps floor (Claude gets it as a system prompt instead, see withNexuraArgs). A worker hired
 * without a prompt gets no note: none of the other CLIs takes a system prompt the office can pass.
 */
export function withNexuraPrompt(prompt: string | undefined, provider: string, dir: string): string | undefined {
  if (!prompt || provider === 'claude') return prompt;
  const note = nexuraAzureNote(dir);
  return note ? `${note}\n\n---\n\n${prompt}` : prompt;
}

/** Who answers, for a floor's WorkerManager, whether one of Nexura's runs sits at a desk (see bridge.ts). */
const desks = new WeakMap<object, (deskId: string) => boolean>();

/** Whether a Nexura run sits at `deskId` on the floor `workers` belongs to. */
export function nexuraDeskTaken(workers: object, deskId: string): boolean {
  return desks.get(workers)?.(deskId) ?? false;
}

/** Set once per floor by the bridge. */
export function watchNexuraDesks(workers: object, taken: (deskId: string) => boolean): void {
  if (!desks.has(workers)) desks.set(workers, taken);
}
