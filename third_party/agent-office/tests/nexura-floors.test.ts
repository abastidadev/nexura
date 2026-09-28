import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Building } from '../src/server/building.js';
import { nexuraCheckout, repoSlug, withNexuraRepos } from '../src/server/nexura/floors.js';
import { azureNote, nexuraClaudeArgs, nexuraCreatePr, nexuraFindPr, parseAzureRemote } from '../src/server/nexura/pulls.js';

const tmp: string[] = [];
function checkout(origin: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexura-floor-'));
  tmp.push(dir);
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}
test.after(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

async function fakeNexura(answer: (method: string, url: URL, body: unknown) => unknown) {
  const seen: { method: string; url: URL; body: unknown }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method ?? 'GET', url, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(req.method ?? 'GET', url, body)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

test('nexura: Azure DevOps remotes are read in every form', () => {
  const want = { organization: 'acme', project: 'My Shop', repository: 'web' };
  assert.deepEqual(parseAzureRemote('https://acme@dev.azure.com/acme/My%20Shop/_git/web'), want);
  assert.deepEqual(parseAzureRemote('git@ssh.dev.azure.com:v3/acme/My%20Shop/web'), want);
  assert.deepEqual(parseAzureRemote('https://acme.visualstudio.com/DefaultCollection/My%20Shop/_git/web'), want);
  assert.equal(parseAzureRemote('https://github.com/o/r.git'), undefined);
});

test('nexura: Claude on an Azure DevOps floor is told how gh translates to az, in one shell-safe line', () => {
  const note = azureNote({ organization: 'acme', project: 'My Shop', repository: 'web' });
  assert.match(note, /az repos pr create --org https:\/\/dev\.azure\.com\/acme --project 'My Shop'/);
  assert.doesNotMatch(note, /[<>|&^%"\n]/);
  const ado = checkout('https://dev.azure.com/acme/Shop/_git/web');
  const [flag, text] = nexuraClaudeArgs(ado);
  assert.equal(flag, '--append-system-prompt');
  assert.match(text, /organization acme, project 'Shop', repository 'web'/);
  assert.deepEqual(nexuraClaudeArgs(checkout('https://github.com/o/r.git')), []);
});

test('nexura: a desk on an Azure DevOps floor opens and finds its pull request through Nexura', async () => {
  const nexura = await fakeNexura((method, url) => (method === 'POST' ? { number: 44, url: 'https://dev.azure.com/acme/Shop/_git/web/pullrequest/44' } : url.searchParams.get('branch') === 'office/sso' ? { pull: { number: 44, url: 'u' } } : { pull: null }));
  try {
    const ado = checkout('https://dev.azure.com/acme/Shop/_git/web');
    const created = await nexuraCreatePr(ado, { branch: 'office/sso', title: 'SSO', body: 'Implements it.\n\nCloses #12' }, nexura.base);
    assert.deepEqual(created, { number: 44, url: 'https://dev.azure.com/acme/Shop/_git/web/pullrequest/44' });
    const post = nexura.seen[0];
    assert.equal(post.url.pathname, '/api/office/board/pulls');
    assert.equal(post.url.searchParams.get('dir'), ado);
    assert.deepEqual(post.body, { branch: 'office/sso', base: 'main', title: 'SSO', body: 'Implements it.\n\nCloses #12', issue: 12 });
    assert.deepEqual(await nexuraFindPr(ado, 'office/sso', nexura.base), { number: 44, url: 'u' });
    assert.equal(await nexuraFindPr(ado, 'other', nexura.base), undefined);

    const github = checkout('https://github.com/o/r.git');
    assert.equal(await nexuraCreatePr(github, { branch: 'b', title: 't', body: '' }, nexura.base), undefined, 'gh opens it');
    assert.equal(await nexuraFindPr(github, 'b', nexura.base), 'not-azure');
  } finally {
    nexura.close();
  }
});

test('nexura: the elevator offers Nexura repos, even when gh is missing', async () => {
  const repos = Promise.resolve([{ name: 'Tienda Web', path: 'C:\\code\\web', provider: 'azure' as const }]);
  const gh = Promise.resolve([{ name: 'o/r', private: false }, { name: 'nexura/nexura', private: false }]);
  assert.deepEqual(
    (await withNexuraRepos(gh, repos)).map((r) => r.name),
    ['nexura/Tienda-Web', 'o/r'],
  );
  assert.match((await withNexuraRepos(gh, repos))[0].description ?? '', /Azure DevOps · C:\\code\\web/);
  assert.deepEqual((await withNexuraRepos(Promise.reject(new Error('gh missing')), repos)).length, 1);
  await assert.rejects(withNexuraRepos(Promise.reject(new Error('gh missing')), Promise.resolve([])), /gh missing/);
  assert.equal(repoSlug('  Tienda Web!! '), 'Tienda-Web');
  assert.deepEqual(await nexuraCheckout('nexura/tienda-web', () => repos), { name: 'Tienda Web', dir: 'C:\\code\\web' });
  assert.equal(await nexuraCheckout('o/r', () => repos), undefined);
});

test('nexura: picking a Nexura repo makes its checkout a floor where it is', async () => {
  const web = checkout('https://dev.azure.com/acme/Shop/_git/web');
  const nexura = await fakeNexura(() => [{ name: 'web', path: web, provider: 'azure' }]);
  const saved = process.env.NEXURA_URL;
  process.env.NEXURA_URL = nexura.base;
  const data = mkdtempSync(path.join(tmpdir(), 'nexura-building-'));
  tmp.push(data);
  try {
    const building = new Building(data, path.join(data, 'projects'));
    const started: string[] = [];
    const def = await building.add('nexura/web', 'Ana', (d) => started.push(d.name));
    assert.ok(typeof def !== 'string', String(def));
    assert.equal(path.resolve(def.dir), path.resolve(web));
    assert.equal(def.repo, undefined, 'not a GitHub repository');
    assert.deepEqual(started, ['web']);
    assert.match(String(await building.add('nexura/web', 'Ana', () => {})), /already has a floor/);
  } finally {
    if (saved === undefined) delete process.env.NEXURA_URL;
    else process.env.NEXURA_URL = saved;
    nexura.close();
  }
});
