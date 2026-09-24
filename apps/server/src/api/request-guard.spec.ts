import { describe, expect, it } from "vitest";
import { rejectReason } from "./request-guard.ts";

const check = (headers: Record<string, string>) => rejectReason({ headers });

describe("rejectReason", () => {
  it("lets the UI, the dev server proxy and non-browser clients through", () => {
    expect(check({ host: "localhost:4310", origin: "http://localhost:4310" })).toBeUndefined();
    expect(check({ host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310", "sec-fetch-site": "same-origin" })).toBeUndefined();
    expect(check({ host: "localhost:4300", origin: "http://localhost:4300" })).toBeUndefined();
    expect(check({ host: "[::1]:4310", origin: "http://[::1]:4310" })).toBeUndefined();
    expect(check({ host: "localhost:4310" })).toBeUndefined();
    expect(check({})).toBeUndefined();
  });

  it("refuses pages from other origins, including a WebSocket to /pty", () => {
    expect(check({ host: "localhost:4310", origin: "https://evil.example" })).toMatch(/Origen/);
    expect(check({ host: "localhost:4310", origin: "http://localhost.evil.example" })).toMatch(/Origen/);
    expect(check({ host: "localhost:4310", origin: "null" })).toMatch(/Origen/);
    expect(check({ host: "localhost:4310", origin: "file://" })).toMatch(/Origen/);
  });

  it("refuses DNS rebinding (foreign Host)", () => {
    expect(check({ host: "rebind.evil.example:4310", origin: "http://rebind.evil.example:4310" })).toMatch(/Host/);
  });

  it("refuses cross-site requests that carry no Origin", () => {
    expect(check({ host: "localhost:4310", "sec-fetch-site": "cross-site" })).toMatch(/cross-site/);
  });
});
