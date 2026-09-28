import test from 'node:test';
import assert from 'node:assert/strict';
import { frameAncestors, frameHeaders } from '../src/server/nexura/frame.js';

test('nexura: office pages may be framed by Nexura on its local ports, other files by nobody', () => {
  const html = frameHeaders('.html', {});
  assert.match(html['content-security-policy'], /^frame-ancestors 'self' /);
  assert.ok(html['content-security-policy'].includes('http://localhost:4310'));
  assert.ok(html['content-security-policy'].includes('http://127.0.0.1:4320'));
  assert.equal(html['x-frame-options'], undefined);
  assert.deepEqual(frameHeaders('.js', {}), { 'x-frame-options': 'DENY' });
});

test('nexura: NEXURA_FRAME_ANCESTORS replaces the default origins and drops anything that is not an origin', () => {
  assert.deepEqual(frameAncestors({ NEXURA_FRAME_ANCESTORS: 'http://localhost:9000  https://nexura.local;evil *' }), ['http://localhost:9000']);
  assert.ok(frameAncestors({ NEXURA_FRAME_ANCESTORS: ' ' }).includes('http://localhost:4310'));
});
