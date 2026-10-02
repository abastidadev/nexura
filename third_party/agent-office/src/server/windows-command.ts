import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { binScript } from './workers/process.js';

/** The Node entry point behind a standard npm .cmd shim, if it can be read safely. */
export function npmNodeShim(command: string): { file: string; script: string } | undefined {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(command)) return undefined;
  try {
    if (statSync(command).size > 16 * 1024) return undefined;
    const source = readFileSync(command, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trimEnd();
    const match = source.match(/"%_prog%"  "%dp0%\\([^"\n]+\.(?:js|cjs|mjs))" %\*$/i);
    if (!match) return undefined;
    // Only bypass cmd.exe for the complete npm cmd-shim template. A wrapper may
    // perform setup or checks before invoking Node, which must not be skipped.
    const expected = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${match[1]}" %*`;
    if (source.toLowerCase() !== expected.toLowerCase()) return undefined;
    const base = path.dirname(command);
    const script = path.resolve(base, match[1]!.replaceAll('\\', path.sep));
    const relative = path.relative(base, script);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !statSync(script).isFile()) return undefined;
    const localNode = path.join(base, 'node.exe');
    const file = (() => {
      try { return statSync(localNode).isFile() ? localNode : process.execPath; }
      catch { return process.execPath; }
    })();
    return { file, script };
  } catch {
    return undefined;
  }
}

/**
 * A PTY spawn of an agent, as it has to be on Windows for a `.cmd`/`.bat` one; anything else as it is.
 * The JS behind a standard npm shim runs with Node directly, keeping newlines and every argv boundary;
 * a custom batch file still needs cmd.exe, through bin/agent-office-cmd.js.
 */
export function windowsSpawn<T extends { file: string; args: string[]; env: Record<string, string> }>(opts: T): T {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(opts.file)) return opts;
  const shim = npmNodeShim(opts.file);
  if (shim) return { ...opts, file: shim.file, args: [shim.script, ...opts.args] };
  // cmd.exe can reinterpret line breaks in an argument as another command.
  if (opts.args.some((arg) => /[\r\n]/.test(arg))) throw new Error('Custom Windows batch agents cannot receive multiline arguments; use an npm shim or .exe');
  const launcher = binScript('agent-office-cmd.js');
  if (!launcher) throw new Error('Windows agent launcher is missing');
  const env = { ...opts.env, AGENT_OFFICE_CMD_TARGET: opts.file, AGENT_OFFICE_CMD_ARGS: Buffer.from(JSON.stringify(opts.args)).toString('base64url') };
  return { ...opts, file: process.execPath, args: [launcher], env };
}
