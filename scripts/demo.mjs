// God mode, to show Nexura off: Nexura and the 3D office side by side (like start-all.mjs), from a
// temporary folder, with the wallet as full as it goes and every room, game and cosmetic of the shop
// already bought. By default the agents are the fakes and the repo is a throwaway sandbox (like
// /try-fake), so nothing spends quota, and before the demo opens it is filled with history
// (scripts/demo-seed.mjs: finished flows with their diffs and PRs, PR reviews, terminal
// conversations), then two flows are left running live. --empty skips that history; --real uses your
// agents and config/repos.json instead (still with a fresh data folder, and no history: it would
// spend quota).
//
//   npm run demo                      # builds the web UI and the office first
//   node scripts/demo.mjs [--real] [--empty] [--coins 999999999] [--port 4310] [--office-port 4600] [--delay 1500]
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import concurrently from "concurrently";
import { fakeAgentsEnv, makeSandbox } from "../fixtures/sandbox.mjs";
import { FAIL_MARKER, seedHistory, seedLive, waitForServer } from "./demo-seed.mjs";

/** As many coins as the wallet shows without spilling over: nine nines. */
const GOD_COINS = 999_999_999;
const PASSWORD = "demo";
/** What the god wears in the office. */
const OUTFIT = { hat: "hat-crown", accessory: "acc-cape", pet: "pet-robot", trail: "trail-rainbow", nametag: "tag-gold" };

const { values } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    empty: { type: "boolean", default: false },
    coins: { type: "string", default: String(GOD_COINS) },
    port: { type: "string", default: "4310" },
    "office-port": { type: "string", default: "4600" },
    delay: { type: "string", default: "1500" },
  },
});
const coins = Number(values.coins);
if (!Number.isSafeInteger(coins) || coins <= 0) {
  console.error("--coins tiene que ser un número entero positivo");
  process.exit(2);
}
const seeded = !values.real && !values.empty;
const home = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "nexura-demo-"));
const dataDir = join(root, "data");
const nexuraUrl = `http://localhost:${values.port}`;

// The stores read their paths from the environment when loaded, so they're loaded only now.
process.env.NEXURA_DATA_DIR = dataDir;
const { RewardStore } = await import("../apps/server/src/rewards/reward-store.ts");
const { SHOP_ITEMS } = await import("../packages/shared/src/rewards.ts");
{
  // The welcome is paid already (in the god coins), so the balance ends up exactly `coins`.
  const wallet = new RewardStore();
  wallet.add({ key: "welcome", at: new Date().toISOString(), amount: 0, reason: "Bienvenida a la tienda de Nexura" });
  wallet.close();
}

// Nexura opens the office inside its own window, on whichever ports these are.
const nexuraEnv = { NEXURA_DATA_DIR: dataDir, NEXURA_OFFICE_WEB_URL: `http://localhost:${values["office-port"]}` };
const officeEnv = { AGENT_OFFICE_PASSWORD: PASSWORD, AGENT_OFFICE_HOME: join(root, "office-home"), NEXURA_FRAME_ANCESTORS: `${nexuraUrl} http://127.0.0.1:${values.port}` };
const officeArgs = ["--host", "127.0.0.1", "--port", values["office-port"], "--no-open"];
const commands = [];
let github;

if (!values.real) {
  const { repoPath, stateDir, prsFile, reposFile } = makeSandbox(root);
  const githubPort = String(Number(values.port) + 1);
  // The fakes edit real code (so the diffs have something to read), and one ticket text makes them fail.
  const fakes = { ...fakeAgentsEnv({ root, stateDir, githubPort, delay: values.delay }), FAKE_DEMO_EDITS: "1", FAKE_FAIL_MARKER: FAIL_MARKER };
  Object.assign(nexuraEnv, { NEXURA_REPOS: reposFile }, fakes);
  // The office runs `claude` itself (its workers, and `claude -p` for the plan's limits): the fakes
  // go first on its PATH.
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, script] of [
    ["claude", "fake-claude.mjs"],
    ["codex", "fake-codex.mjs"],
    ["copilot", "fake-copilot.mjs"],
  ]) {
    const target = join(home, "fixtures", script);
    if (process.platform === "win32") writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
    else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  Object.assign(officeEnv, { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}` }, fakes);
  officeArgs.unshift(repoPath);
  // --merge-created: the PRs the flows open read as merged, so the Hall of Fame fills up.
  github = { script: join(home, "fixtures", "fake-github.mjs"), args: ["--port", githubPort, "--prs", prsFile, "--state", stateDir, "--merge-created"] };
  commands.push({ name: "github", command: `"${process.execPath}" "${github.script}" ${github.args.map((a) => `"${a}"`).join(" ")}` });
}

if (seeded) {
  // The history, on a Nexura of its own with no delay in the fakes; stopped before the demo starts.
  console.log("\n  🌱 Preparando la demo (flujos, revisiones y conversaciones de ejemplo)…");
  const children = [
    spawn(process.execPath, [github.script, ...github.args], { cwd: home, stdio: "ignore" }),
    spawn(process.execPath, ["apps/server/src/cli/cli.ts", "serve", "--port", values.port], {
      cwd: home,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, ...nexuraEnv, FAKE_DELAY_MS: "0" },
    }),
  ];
  try {
    await waitForServer(nexuraUrl);
    await seedHistory(nexuraUrl, (line) => console.log(line));
  } catch (error) {
    console.error(`\n  No se pudo preparar la demo: ${error instanceof Error ? error.message : String(error)}`);
    for (const child of children) child.kill();
    process.exit(1);
  }
  await Promise.all(children.map((child) => new Promise((done) => (child.exitCode !== null ? done() : (child.once("exit", done), child.kill())))));
}

{
  // God mode: every room, game and cosmetic bought, the outfit on, and the balance topped up to `coins`.
  const wallet = new RewardStore();
  const now = new Date().toISOString();
  const owned = wallet.owned();
  const missing = SHOP_ITEMS.filter((item) => !owned.has(item.id));
  wallet.add({ key: "god-shop", at: now, amount: missing.reduce((sum, item) => sum + item.price, 0), reason: "Modo god: la tienda entera" });
  for (const item of missing) wallet.buy(item.id, item.price, now, `Compra: ${item.icon} ${item.name}`);
  for (const [slot, item] of Object.entries(OUTFIT)) wallet.equip(slot, item);
  wallet.add({ key: "god", at: now, amount: coins - wallet.balance(), reason: "Modo god" });
  wallet.close();
}

const shared = {
  NEXURA_OFFICE_TOKEN: randomBytes(24).toString("base64url"),
  NEXURA_OFFICE_URL: `http://127.0.0.1:${values["office-port"]}`,
  NEXURA_URL: nexuraUrl,
};
const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
commands.push(
  { name: "nexura", command: `"${process.execPath}" apps/server/src/cli/cli.ts serve --port ${values.port}`, env: { ...shared, ...nexuraEnv } },
  { name: "office", command: `"${process.execPath}" third_party/agent-office/bin/agent-office.js ${officeArgs.map(quote).join(" ")}`, env: { ...shared, ...officeEnv } },
);

const { result } = concurrently(commands, { cwd: home, killOthersOn: ["failure", "success"], prefix: "name" });
result.then(
  () => process.exit(0),
  () => process.exit(1),
);

await waitForServer(nexuraUrl);
if (seeded) await seedLive(nexuraUrl, (line) => console.log(line));
console.log(`
  🚀 Nexura en modo god
     Nexura:  ${nexuraUrl}
     Oficina: http://localhost:${values["office-port"]}  (contraseña: ${PASSWORD})
     🪙 ${coins.toLocaleString("es-ES")} monedas · toda la tienda comprada (salas, juegos y ropa)
     ${values.real ? "⚠️  Agentes y repos reales (config/repos.json): los flujos gastan cuota." : "Agentes falsos y un repo de prueba: no se gasta cuota."}
     Datos temporales en ${root}
`);
