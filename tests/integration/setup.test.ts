import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const dirs: string[] = [];
const cleanupProcs: { kill: () => void }[] = [];

afterEach(() => {
  for (const proc of cleanupProcs.splice(0)) {
    try { proc.kill(); } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Walks the relative imports reachable from the installed entry points and
 * returns the ones that were not copied. The installer copies an explicit file
 * whitelist, so a forgotten module stays invisible until the Worker refuses to
 * start on a user's machine.
 */
function missingInstalledImports(entries: string[]): string[] {
  const queue = [...entries];
  const seen = new Set<string>();
  const missing: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    if (!existsSync(file)) {
      missing.push(file);
      continue;
    }
    const source = readFileSync(file, 'utf-8');
    for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const base = resolve(dirname(file), spec!);
      const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
      const resolved = candidates.find((c) => c.endsWith('.ts') && existsSync(c));
      queue.push(resolved ?? `${base}.ts`);
    }
  }
  return missing;
}

function fakeCommand(dir: string, name: string, body = 'exit 0') {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function runCli(args: string[], env: Record<string, string>) {
  // The global test preload sets KIRO_MEMORY_DATA_DIR; this test asserts the
  // installer's HOME-derived layout, so the child must not inherit it.
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv.KIRO_MEMORY_DATA_DIR;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', SETUP, ...args],
    cwd: ROOT, env: childEnv,
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('V3 purge and clean install', () => {
  test('purges all old state, then installs only the V3 runtime into isolated homes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-home-'));
    dirs.push(home);
    const kiroHome = join(home, 'kiro-home');
    const dataDir = join(home, '.kiro-mem');
    const agentDir = join(kiroHome, 'agents');
    const binDir = join(home, 'bin');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(dataDir, 'legacy-marker'), 'v2');
    writeFileSync(join(agentDir, 'kiro-mem.json'), '{"legacy":true}');

    fakeCommand(binDir, 'launchctl');
    fakeCommand(binDir, 'systemctl');
    fakeCommand(binDir, 'kiro-cli', 'echo "kiro-cli 3.0.0"; exit 0');
    fakeCommand(binDir, 'bun', 'if [ "$1" = "--version" ]; then echo "1.2.20"; fi; exit 0');
    const env = {
      HOME: home,
      KIRO_HOME: kiroHome,
      KIRO_MEMORY_LANGUAGE: 'en',
      PATH: `${binDir}:${process.env.PATH}`,
    };

    const purge = await runCli(['uninstall', '--purge'], env);
    expect(purge.exitCode).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(agentDir, 'kiro-mem.json'))).toBe(false);

    const install = await runCli(['install'], env);
    expect(install.exitCode).toBe(0);
    expect(install.stderr).toBe('');
    expect(existsSync(join(dataDir, 'src/server/worker.ts'))).toBe(true);
    expect(existsSync(join(dataDir, 'src/server/mcp-server.ts'))).toBe(true);
    expect(existsSync(join(dataDir, 'hooks/context.ts'))).toBe(true);
    expect(existsSync(join(dataDir, 'kiro-runtime/agents/kiro-mem-compressor.json'))).toBe(true);
    expect(existsSync(join(agentDir, 'kiro-mem.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, 'package.json'), 'utf-8')).version).toBe('3.0.0');
    expect(readFileSync(join(dataDir, '.token'), 'utf-8')).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(dataDir, '.token')).mode & 0o777).toBe(0o600);

    expect(
      missingInstalledImports([
        join(dataDir, 'src/server/worker.ts'),
        join(dataDir, 'src/server/mcp-server.ts'),
        join(dataDir, 'hooks/context.ts'),
        join(dataDir, 'hooks/prompt-save.ts'),
        join(dataDir, 'hooks/observation.ts'),
        join(dataDir, 'hooks/stop.ts'),
      ]),
    ).toEqual([]);

    const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
    const tables = (db.raw.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('observations');
    expect(tables).not.toContain('topics');
    expect(tables).not.toContain('memories');
    db.close();

    const finalPurge = await runCli(['uninstall', '--purge'], env);
    expect(finalPurge.exitCode).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(agentDir, 'kiro-mem.json'))).toBe(false);
  }, 20_000);

  test('restarts a Worker that predates the copied build, and stays quiet on a fresh install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-home-'));
    dirs.push(home);
    const dataDir = join(home, '.kiro-mem');
    const binDir = join(home, 'bin');
    mkdirSync(join(home, 'kiro-home', 'agents'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir);

    const launchctlLog = join(home, 'launchctl.log');
    fakeCommand(binDir, 'launchctl', `echo "$@" >> ${launchctlLog}\nexit 0`);
    fakeCommand(binDir, 'systemctl', `echo "$@" >> ${launchctlLog}\nexit 0`);
    fakeCommand(binDir, 'kiro-cli', 'echo "kiro-cli 3.0.0"; exit 0');
    fakeCommand(binDir, 'bun', 'if [ "$1" = "--version" ]; then echo "1.2.20"; fi; exit 0');
    const env = {
      HOME: home,
      KIRO_HOME: join(home, 'kiro-home'),
      KIRO_MEMORY_LANGUAGE: 'en',
      PATH: `${binDir}:${process.env.PATH}`,
    };

    // Nothing running yet: the install must not claim it stopped a Worker.
    const fresh = await runCli(['install'], env);
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout).toContain('Worker started');
    expect(fresh.stdout).not.toContain('Worker stopped');
    expect(fresh.stdout).not.toContain('Worker restarted');

    // Stand in for a Worker started before this install: a live process whose
    // pid the installer will find in .worker.pid.
    const stale = Bun.spawn({ cmd: ['sleep', '300'], stdout: 'ignore', stderr: 'ignore' });
    cleanupProcs.push(stale);
    writeFileSync(join(dataDir, '.worker.pid'), String(stale.pid));
    writeFileSync(join(dataDir, '.worker.port'), '37778');

    const repair = await runCli(['install'], env);
    expect(repair.exitCode).toBe(0);
    expect(repair.stdout).toContain('Worker stopped');
    expect(repair.stdout).toContain('Worker restarted');
    // Not the no-op path: the installer must never report "already running".
    expect(repair.stdout).not.toContain('Worker already running');

    // The stale process is gone and launchd was told to reload.
    expect(spawnSync('kill', ['-0', String(stale.pid)]).status).not.toBe(0);
    const launchctlCalls = readFileSync(launchctlLog, 'utf-8');
    expect(launchctlCalls).toContain('unload');
    expect(launchctlCalls).toContain('load');
  }, 30_000);
});
