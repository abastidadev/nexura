import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanLimitsReader } from '../src/server/limits.js';
import { TaskNamer } from '../src/server/tasks.js';
import { npmNodeShim } from '../src/server/windows-command.js';

function npmShim(script: string): string {
  return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
}

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexura office cmd '));
  const command = path.join(dir, 'claude.cmd');
  const argsLog = path.join(dir, 'args.json');
  writeFileSync(path.join(dir, 'fake.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.NEXURA_TEST_ARGS_LOG, JSON.stringify(args));
if (args.includes('--input-format')) {
  process.stdin.once('data', () => {
    console.log(JSON.stringify({ type: 'control_response', response: { request_id: 'usage', subtype: 'success', response: {
      subscription_type: 'pro', rate_limits: { five_hour: { utilization: 42, resets_at: '2026-10-01T00:00:00Z' } }
    } } }));
  });
} else {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => console.log(JSON.stringify({ structured_output: { name: 'Fake task', summary: input.trim().slice(0, 100) } })));
}
`);
  writeFileSync(command, npmShim('fake.cjs'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NEXURA_TEST_ARGS_LOG: argsLog };
  return { command, argsLog, env };
}

test('only complete npm command shims bypass their batch wrapper', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  assert.equal(npmNodeShim(f.command)?.script, path.join(path.dirname(f.command), 'fake.cjs'));
  writeFileSync(f.command, `@ECHO off\r\nSET WRAPPER_CHECK=required\r\n${npmShim('fake.cjs')}`);
  assert.equal(npmNodeShim(f.command), undefined);
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fake claude timeout')), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

test('Windows claude.cmd returns plan limits without launching a real agent', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  let resolve!: (value: { plan?: string; windows: { pct: number }[] }) => void;
  const received = new Promise<{ plan?: string; windows: { pct: number }[] }>(done => resolve = done);
  const reader = new PlanLimitsReader(f.command, f.env, () => true, limits => resolve(limits));
  try {
    const limits = await within(received);
    assert.equal(limits.plan, 'pro');
    assert.equal(limits.windows[0]?.pct, 42);
    assert.ok(JSON.parse(readFileSync(f.argsLog, 'utf8')).includes('--input-format'));
  } finally {
    reader.close();
  }
});

test('Windows claude.cmd names tasks with JSON and prompt arguments intact', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  let resolve!: (value: { name: string; summary: string }) => void;
  const received = new Promise<{ name: string; summary: string }>(done => resolve = done);
  const namer = new TaskNamer(f.command, f.env, () => 'Use names with & and quotes "safely"', (_id, task) => resolve(task));
  namer.request('worker-1', { prompts: ['Fix login'], tools: [], epoch: 0 });
  const task = await within(received);
  assert.equal(task.name, 'Fake task');
  assert.match(task.summary, /Fix login/);
  const args = JSON.parse(readFileSync(f.argsLog, 'utf8')) as string[];
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'Use names with & and quotes "safely"');
  assert.doesNotThrow(() => JSON.parse(args[args.indexOf('--json-schema') + 1]!));
});
