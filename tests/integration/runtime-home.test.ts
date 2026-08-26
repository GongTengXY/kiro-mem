/**
 * P1-5 — one answer to "where is the compressor runtime?".
 *
 * Five places need that path: install (lay files down), `config` (display and
 * preserve), `diagnose` (integrity check), the ACP smoke test, and the Worker
 * (run it). They used to compute it three different ways, and the failure was
 * quiet rather than loud: a user with a custom `runtime.kiroHome` had a working
 * runtime that `diagnose` declared broken because it inspected the default
 * directory, and a re-install silently threw the setting away.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { resolveRuntimeHome, DEFAULT_RUNTIME_DIRNAME } from '../../src/config';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCommand(dir: string, name: string, body = 'exit 0') {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function runCli(args: string[], env: Record<string, string>) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv.KIRO_MEMORY_DATA_DIR;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', SETUP, ...args],
    cwd: ROOT, env: childEnv, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('resolveRuntimeHome', () => {
  test('an unset value falls back to <dataDir>/kiro-runtime', () => {
    expect(resolveRuntimeHome('', '/data')).toBe(join('/data', DEFAULT_RUNTIME_DIRNAME));
    expect(resolveRuntimeHome(undefined, '/data')).toBe(join('/data', DEFAULT_RUNTIME_DIRNAME));
    expect(resolveRuntimeHome(null, '/data')).toBe(join('/data', DEFAULT_RUNTIME_DIRNAME));
  });

  test('a whitespace-only value is treated as unset, not as a path', () => {
    expect(resolveRuntimeHome('   ', '/data')).toBe(join('/data', DEFAULT_RUNTIME_DIRNAME));
  });

  test('an explicit value wins and is trimmed', () => {
    expect(resolveRuntimeHome('/custom/runtime', '/data')).toBe('/custom/runtime');
    expect(resolveRuntimeHome('  /custom/runtime  ', '/data')).toBe('/custom/runtime');
  });
});

describe('the deployment chain agrees on the runtime home', () => {
  test('install writes an unset kiroHome instead of freezing the default path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-p15-default-'));
    dirs.push(home);
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    fakeCommand(binDir, 'launchctl');
    fakeCommand(binDir, 'systemctl');
    fakeCommand(binDir, 'kiro-cli', 'echo "kiro-cli 3.0.0"; exit 0');
    fakeCommand(binDir, 'bun', 'if [ "$1" = "--version" ]; then echo "1.2.20"; fi; exit 0');

    const env = {
      HOME: home, KIRO_HOME: join(home, 'kiro-home'),
      KIRO_MEMORY_LANGUAGE: 'en', PATH: `${binDir}:${process.env.PATH}`,
    };
    const install = await runCli(['install'], env);
    expect(install.exitCode).toBe(0);

    const dataDir = join(home, '.kiro-mem');
    const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'));
    // Empty, not the absolute default path: the config records the user's
    // choice, and "no choice" must stay "no choice".
    expect(cfg.runtime.kiroHome).toBe('');
    // …while the files still land in the resolved default location.
    expect(existsSync(join(dataDir, 'kiro-runtime/agents/kiro-mem-compressor.json'))).toBe(true);

    // `config --show` resolves it for display rather than printing the raw empty
    // string, so the user can see where it actually is.
    const show = await runCli(['config', '--show'], env);
    expect(show.stdout).toContain(join(dataDir, 'kiro-runtime'));
  });

  test('a custom kiroHome survives re-install and is what diagnose inspects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-p15-custom-'));
    dirs.push(home);
    const binDir = join(home, 'bin');
    const dataDir = join(home, '.kiro-mem');
    const customRuntime = join(home, 'my-runtime');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    fakeCommand(binDir, 'launchctl');
    fakeCommand(binDir, 'systemctl');
    fakeCommand(binDir, 'kiro-cli', 'echo "kiro-cli 3.0.0"; exit 0');
    fakeCommand(binDir, 'bun', 'if [ "$1" = "--version" ]; then echo "1.2.20"; fi; exit 0');

    // A pre-existing config that points somewhere else.
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      language: 'en',
      worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
      compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
      context: { maxOutputBytes: 8192 },
      filter: { skipTools: [] },
      runtime: { kiroHome: customRuntime },
    }, null, 2));

    const env = {
      HOME: home, KIRO_HOME: join(home, 'kiro-home'),
      KIRO_MEMORY_LANGUAGE: 'en', PATH: `${binDir}:${process.env.PATH}`,
    };
    const install = await runCli(['install'], env);
    expect(install.exitCode).toBe(0);

    // Preserved, not overwritten.
    const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'));
    expect(cfg.runtime.kiroHome).toBe(customRuntime);

    // The runtime files were laid down at the custom path, and NOT at the
    // default one — otherwise the Worker and the installer disagree.
    expect(existsSync(join(customRuntime, 'agents/kiro-mem-compressor.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'kiro-runtime/agents/kiro-mem-compressor.json'))).toBe(false);

    // diagnose reports the custom path, and its integrity check passes because
    // it inspects that same directory.
    const diag = await runCli(['diagnose'], env);
    expect(diag.stdout).toContain(customRuntime);
    expect(diag.stdout).not.toContain('runtime is incomplete');

    // `config --show` agrees.
    const show = await runCli(['config', '--show'], env);
    expect(show.stdout).toContain(customRuntime);
  });
});
