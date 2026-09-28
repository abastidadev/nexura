// Windows PTY launcher for npm-installed agent CLIs. The parent passes argv in the environment
// because ConPTY cannot launch a .cmd/.bat with its argument boundaries intact.
import spawn from 'cross-spawn';

const target = process.env.AGENT_OFFICE_CMD_TARGET;
const encoded = process.env.AGENT_OFFICE_CMD_ARGS;
delete process.env.AGENT_OFFICE_CMD_TARGET;
delete process.env.AGENT_OFFICE_CMD_ARGS;

let args;
try {
  args = JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8'));
  if (!target || !/\.(?:cmd|bat)$/i.test(target) || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !/[\r\n]/.test(arg))) throw new Error('Invalid agent command');
} catch {
  process.stderr.write('Invalid Windows agent command\n');
  process.exit(1);
}

const child = spawn(target, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`Could not start agent: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
