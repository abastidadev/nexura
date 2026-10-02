import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.ts'));

function run(files, options = []) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import=#tests/css', '--test', ...options, ...files.map((file) => path.join('tests', file))], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// On Windows, ConPTY can keep handles open after the worker tests finish.
// Force-exit only that file: forcing HTTP test processes can trip a Node/libuv assertion.
run(tests.filter((name) => name !== 'workers.test.ts'));
run(['workers.test.ts'], process.platform === 'win32' ? ['--test-isolation=none', '--test-force-exit'] : []);
