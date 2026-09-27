// A tiny stand-in for api.github.com, enough for /try-fake: the open PRs of the sandbox,
// their (empty) review threads, creating PRs and posting reviews. What gets posted is
// appended to <state>/github-posts.jsonl so it can be checked by hand. No network.
//
//   node fixtures/fake-github.mjs --port 4321 --prs <prs.json> --state <dir>
//
// Point Nexura at it with NEXURA_GITHUB_API_URL=http://127.0.0.1:<port> (and GH_TOKEN=anything).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4321" }, prs: { type: "string" }, state: { type: "string", default: "." } } });
const posts = join(values.state, "github-posts.jsonl");
let nextPr = 100;

/** `[{ number, title, body, user, head: { ref, sha }, base: { ref }, draft, html_url, created_at }]`, re-read on every request. */
function openPrs() {
  return values.prs && existsSync(values.prs) ? JSON.parse(readFileSync(values.prs, "utf8")) : [];
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const record = () => appendFileSync(posts, JSON.stringify({ at: new Date().toISOString(), method: request.method, path, body }) + "\n");

  if (request.method === "GET" && path === "/user") {
    return send(response, 200, { login: "nexura-fake" });
  }
  if (request.method === "POST" && path === "/graphql") {
    // Review threads: none open (enough for the reviewer's "don't repeat" context).
    return send(response, 200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  }
  let match = /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(path);
  if (match && request.method === "GET") {
    return send(response, 200, openPrs());
  }
  if (match && request.method === "POST") {
    record();
    const number = nextPr++;
    return send(response, 201, { number, title: body?.title ?? "", html_url: `https://github.com/nexura-fake/sandbox/pull/${number}` });
  }
  match = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
  if (match && request.method === "GET") {
    const pr = openPrs().find((candidate) => candidate.number === Number(match[1]));
    return pr ? send(response, 200, { ...pr, state: "open", merged: false }) : send(response, 404, { message: "Not Found" });
  }
  match = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
  if (match && request.method === "POST") {
    record();
    return send(response, 200, { id: Date.now(), state: body?.event ?? "COMMENTED" });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/issues/.test(path)) {
    return send(response, 200, []);
  }
  send(response, 404, { message: "Not Found (fake GitHub)" });
}).listen(Number(values.port), "127.0.0.1", () => console.log(`fake GitHub at http://127.0.0.1:${values.port}`));
