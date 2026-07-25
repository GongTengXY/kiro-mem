import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

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
});
