import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanLimitsReader } from '../src/server/limits.js';

test('a claude.cmd that Node cannot spawn leaves the office running without plan limits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexura-limits-'));
  const cmd = path.join(dir, 'claude.cmd');
  writeFileSync(cmd, '@echo off\r\nexit /b 0\r\n');
  const reader = new PlanLimitsReader(cmd, {}, () => true, () => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(reader.state.windows, []);
  } finally {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
