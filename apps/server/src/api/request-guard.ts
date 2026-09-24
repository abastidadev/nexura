import type { IncomingMessage } from "node:http";

/**
 * Listening on 127.0.0.1 does not stop a web page in the user's browser from reaching the
 * API: browsers allow cross-origin WebSockets (`/pty` is a shell), `text/plain` POSTs skip
 * the CORS preflight, and DNS rebinding can point any domain at 127.0.0.1. Only requests
 * from a local page (any port: the Angular dev server proxies from :4300) or from a
 * non-browser client (CLI, curl, tests: no Origin) get through.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(host: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Why the request is refused, or undefined if it may go on. */
export function rejectReason(request: Pick<IncomingMessage, "headers">): string | undefined {
  const { host, origin } = request.headers;
  // DNS rebinding: the browser sends the attacker's domain as Host.
  if (host && !isLocalHost(host)) {
    return `Host no permitido: ${host}`;
  }
  // Browsers always send Origin on WebSocket upgrades and cross-origin POST/PUT/DELETE.
  if (origin !== undefined && !isLocalOrigin(origin)) {
    return `Origen no permitido: ${origin}`;
  }
  // Requests without Origin (no-cors GETs, forms in some browsers) still carry Sec-Fetch-Site.
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return "Petición cross-site no permitida";
  }
  return undefined;
}
