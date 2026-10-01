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
