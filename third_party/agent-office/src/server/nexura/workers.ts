// nexura: Nexura's hooks in workers/manager.ts, from one module so they cost that file one import line
// (it is at its ceiling in tests/size.test.ts).
import { nexuraClaudeArgs } from './pulls.js';
export { windowsSpawn } from '../windows-command.js';

/** A Claude worker's arguments, plus on an Azure DevOps floor (`dir`) how gh translates to az (see pulls.ts). */
export function withNexuraArgs(args: string[], provider: string, dir: string): string[] {
  return provider === 'claude' ? [...args, ...nexuraClaudeArgs(dir)] : args;
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
