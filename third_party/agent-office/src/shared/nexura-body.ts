// nexura: the build of a person in the office (Look.body), picked on the character select screen next
// to the skin and the hair. An index into BODY_TYPES, like the rest of a look; 0 is the office's own
// body, so a look from before there were builds (or from a client without them) keeps it.

export const BODY_TYPES = ['Average', 'Slim', 'Strong', 'Chubby'] as const;

/** A valid build index: `v` when it is one, else `fallback`'s, else the average one. */
export function sanitizeBody(v: unknown, fallback?: number): number {
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < BODY_TYPES.length;
  return ok(v) ? v : ok(fallback) ? fallback : 0;
}

export function randomBody(): number {
  return Math.floor(Math.random() * BODY_TYPES.length);
}
