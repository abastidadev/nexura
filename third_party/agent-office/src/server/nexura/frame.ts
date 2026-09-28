// nexura: lets Nexura's local UI embed the office pages in an iframe; everything else keeps DENY.

/** Nexura's production, development and try-fake ports. */
const DEFAULT_PORTS = [4300, 4310, 4320, 4330];

/** Origins allowed to frame the office: NEXURA_FRAME_ANCESTORS (space separated) or Nexura's local ports. */
export function frameAncestors(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.NEXURA_FRAME_ANCESTORS?.split(/\s+/).filter((origin) => /^https?:\/\/[^\s;,']+$/.test(origin));
  if (configured?.length) return configured;
  return DEFAULT_PORTS.flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

/** Framing headers for a served file: HTML pages may be framed by Nexura, the rest by nobody. */
export function frameHeaders(ext: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (ext !== '.html') return { 'x-frame-options': 'DENY' };
  return { 'content-security-policy': `frame-ancestors 'self' ${frameAncestors(env).join(' ')}` };
}
