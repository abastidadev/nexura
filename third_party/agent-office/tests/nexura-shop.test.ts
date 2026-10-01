import test from 'node:test';
import assert from 'node:assert/strict';
import { nexuraTarget } from '../src/server/nexura/proxy.js';
import { outfitKey, sanitizeOutfit } from '../src/shared/nexura-outfit.js';

test('nexura: only the shop, bets, trivia, digest and continuing a flow go through to Nexura', () => {
  assert.equal(nexuraTarget('GET', '/api/nexura/rewards'), '/api/rewards');
  assert.equal(nexuraTarget('GET', '/api/nexura/digest'), '/api/office/digest');
  assert.equal(nexuraTarget('POST', '/api/nexura/rewards/buy'), '/api/rewards/buy');
  assert.equal(nexuraTarget('POST', '/api/nexura/runs/abc-123/continue'), '/api/office/runs/abc-123/continue');
  assert.equal(nexuraTarget('GET', '/api/nexura/rewards/buy'), undefined);
  assert.equal(nexuraTarget('POST', '/api/nexura/rewards/../settings'), undefined);
  assert.equal(nexuraTarget('POST', '/api/nexura/runs/../../settings/continue'), undefined);
  assert.equal(nexuraTarget('DELETE', '/api/nexura/rewards'), undefined);
  assert.equal(nexuraTarget('GET', '/api/nexura/settings'), undefined);
});

test('nexura: an outfit keeps only known items, each in its own slot', () => {
  assert.deepEqual(sanitizeOutfit({ hat: 'hat-crown', pet: 'pet-cat', trail: 'nope', accessory: 'hat-cap', extra: 'x' }), { hat: 'hat-crown', pet: 'pet-cat' });
  assert.equal(sanitizeOutfit({}), undefined);
  assert.equal(sanitizeOutfit('hat-crown'), undefined);
  assert.equal(outfitKey(undefined), '');
  assert.notEqual(outfitKey({ hat: 'hat-cap' }), outfitKey({ hat: 'hat-chef' }));
});

test('nexura: agents other than Claude get the Azure DevOps note ahead of their first prompt, only on an Azure DevOps floor', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { withNexuraPrompt } = await import('../src/server/nexura/workers.js');
  const ado = mkdtempSync(path.join(tmpdir(), 'nexura-ado-'));
  const gh = mkdtempSync(path.join(tmpdir(), 'nexura-gh-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: ado });
    execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/org/proj/_git/app'], { cwd: ado });
    execFileSync('git', ['init', '-q'], { cwd: gh });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/app.git'], { cwd: gh });
    assert.match(withNexuraPrompt('fix it', 'codex', ado) ?? '', /az [\s\S]*---\n\nfix it$/);
    assert.equal(withNexuraPrompt('fix it', 'claude', ado), 'fix it');
    assert.equal(withNexuraPrompt('fix it', 'codex', gh), 'fix it');
    assert.equal(withNexuraPrompt(undefined, 'codex', ado), undefined);
  } finally {
    rmSync(ado, { recursive: true, force: true });
    rmSync(gh, { recursive: true, force: true });
  }
});
