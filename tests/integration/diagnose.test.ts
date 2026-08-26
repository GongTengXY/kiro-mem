import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/**
 * Stands in for a running Worker: only `/context/bootstrap` is authenticated,
 * exactly like the real one, so diagnose's probe exercises the real contract.
 */
function fakeWorker(expectedToken: string, version = '3.0.0') {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return Response.json({ status: 'ok', version, jobs: {} });
      if (req.headers.get('Authorization') !== `Bearer ${expectedToken}`) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      return new Response('bootstrap index');
    },
  });
  cleanups.push(() => server.stop(true));
  return server.port;
}

async function runDiagnose(home: string) {
  const binDir = join(home, 'bin');
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', SETUP, 'diagnose'],
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      KIRO_HOME: join(home, 'kiro-home'),
      KIRO_MEMORY_DATA_DIR: undefined,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), proc.exited,
  ]);
  // eslint-disable-next-line no-control-regex
  return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), exitCode };
}

function isolatedHome(): { home: string; dataDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'kiro-mem-diag-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, '.kiro-mem');
  const binDir = join(home, 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir);
  // diagnose picks its language from config.json, not from the environment.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ language: 'en' }));
  for (const name of ['kiro-cli', 'bun', 'launchctl', 'systemctl']) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return { home, dataDir };
}

describe('diagnose / local auth', () => {
  test('reports a healthy auth chain, a rotated token and a missing token', async () => {
    const { home, dataDir } = isolatedHome();
    const token = 'a'.repeat(64);
    const port = fakeWorker(token);

    writeFileSync(join(dataDir, '.token'), token, { mode: 0o600 });
    // Make the Worker look alive: diagnose checks `kill -0 <pid>` then the port.
    writeFileSync(join(dataDir, '.worker.pid'), String(process.pid));
    writeFileSync(join(dataDir, '.worker.port'), String(port));

    const healthy = await runDiagnose(home);
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stdout).toContain('token present (mode 0600)');
    expect(healthy.stdout).toContain('Hook → Worker authenticated');
    expect(healthy.stdout).not.toContain(token);

    // Token regenerated after the Worker started: the chain must break loudly.
    writeFileSync(join(dataDir, '.token'), 'c'.repeat(64), { mode: 0o600 });
    const rotated = await runDiagnose(home);
    expect(rotated.stdout).toContain('Worker rejected the local token (401)');
    expect(rotated.stdout).toContain('kiro-mem stop && kiro-mem start');

    rmSync(join(dataDir, '.token'));
    const missing = await runDiagnose(home);
    expect(missing.stdout).toContain('.token is missing');

    // A past rejection stays visible for 24h so a fixed-but-silent failure is
    // still traceable; a clean install never prints this line.
    expect(missing.stdout).not.toContain('auth 401s');
    const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
    db.recordAuthEvent('unauthorized');
    db.close();
    const withRejections = await runDiagnose(home);
    expect(withRejections.stdout).toContain('auth 401s');
    expect(withRejections.stdout).toContain('Hook writes failed silently');
  }, 20_000);
});

describe('diagnose / version drift', () => {
  test('flags a Worker still running code from before the install', async () => {
    const { home, dataDir } = isolatedHome();
    const token = 'a'.repeat(64);
    // The Worker reports the build it booted with; the data dir holds what the
    // installer just wrote.
    const port = fakeWorker(token, '3.0.0');
    writeFileSync(join(dataDir, '.token'), token, { mode: 0o600 });
    writeFileSync(join(dataDir, '.worker.pid'), String(process.pid));
    writeFileSync(join(dataDir, '.worker.port'), String(port));

    writeFileSync(join(dataDir, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    const matching = await runDiagnose(home);
    expect(matching.stdout).not.toContain('not the installed build');

    writeFileSync(join(dataDir, 'package.json'), JSON.stringify({ version: '3.1.0' }));
    const drifted = await runDiagnose(home);
    expect(drifted.stdout).toContain('not the installed build');
    expect(drifted.stdout).toContain('kiro-mem stop && kiro-mem start');
    expect(drifted.stdout).toContain('worker v3.0.0 / installed v3.1.0');
  }, 20_000);
});
