// Starts Nexura and the 3D office side by side, sharing a fresh token so Nexura can show its runs as
// workers in the office (apps/server/src/office/office-bridge.ts, third_party/agent-office/src/server/nexura).
// `npm run start:all` builds the web UI first.
import { randomBytes } from "node:crypto";
import concurrently from "concurrently";

const NEXURA_PORT = 4310;
const OFFICE_PORT = 4600;

const env = {
  NEXURA_OFFICE_TOKEN: randomBytes(24).toString("base64url"),
  NEXURA_OFFICE_URL: `http://127.0.0.1:${OFFICE_PORT}`,
  NEXURA_URL: `http://localhost:${NEXURA_PORT}`,
};

const { result } = concurrently(
  [
    { name: "nexura", command: `node apps/server/src/cli/cli.ts serve --port ${NEXURA_PORT}`, env },
    { name: "office", command: `node third_party/agent-office/bin/agent-office.js --host 127.0.0.1 --port ${OFFICE_PORT}`, env },
  ],
  { killOthersOn: ["failure", "success"], prefix: "name" },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
