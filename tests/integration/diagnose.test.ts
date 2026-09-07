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
function fakeWorker(expectedToken: string, version = '3.0.0', healthExtra: Record<string, unknown> = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', version, jobs: {}, ...healthExtra });
      }
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

function isolatedHome(language: 'zh' | 'en' = 'en'): { home: string; dataDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'kiro-mem-diag-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, '.kiro-mem');
  const binDir = join(home, 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir);
  // diagnose picks its language from config.json, not from the environment.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ language }));
  for (const name of ['kiro-cli', 'bun', 'launchctl', 'systemctl']) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return { home, dataDir };
}

/**
 * The config section reports what the Worker will use, not what the file says.
 * Echoing a value the loader already rejected sends the reader to debug the wrong
 * thing: they see the number they typed and conclude it is in effect.
 */
describe('diagnose / config section', () => {
  test('prints the handshake budget in effect, not the rejected one on disk', async () => {
    const { home, dataDir } = isolatedHome('en');
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        language: 'en',
        // Both unusable: the Worker runs on 30000 and 5000.
        compression: { startupTimeoutMs: 0, timeoutMs: 250 },
      }),
    );

    const out = await runDiagnose(home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/Handshake timeout \(ms\):\s+30000/);
    expect(out.stdout).toMatch(/Compression timeout \(ms\):\s+5000/);
  }, 20_000);

  test('still renders the section when config.json cannot be parsed', async () => {
    const { home, dataDir } = isolatedHome('en');
    writeFileSync(join(dataDir, 'config.json'), '{ not json');

    const out = await runDiagnose(home);
    // In Chinese, because the language is read from that same unreadable file.
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('配置文件解析失败');
  }, 20_000);
});

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

/**
 * ACP idle governance in `kiro-mem diagnose`.
 *
 * `diagnose` is the command the runtime data-collection guide asks users to run,
 * so it is the only place most people will ever see whether idle ACP processes
 * are actually being released. A counter that exists solely in `/health` would be
 * shipped but unreachable.
 */
describe('diagnose / ACP idle governance', () => {
  const liveHealth = (acpConfig: Record<string, unknown>, idleRecycles: number) => ({
    memory: {
      workerSelfRssBytes: 120 * 1048576,
      acpSlots: [
        { pid: 4242, rssBytes: 38 * 1048576, jobCount: 3, idleMs: 12_000, busy: false },
      ],
      acpAttributedSubtreeRssBytes: 38 * 1048576,
      mcpClientsSeen: [],
      rssMeasured: true,
    },
    acp: { idleRecycles, config: acpConfig },
  });

  function liveWorker(home: string, dataDir: string, health: Record<string, unknown>) {
    const token = 'a'.repeat(64);
    const port = fakeWorker(token, '3.0.0', health);
    writeFileSync(join(dataDir, '.token'), token, { mode: 0o600 });
    writeFileSync(join(dataDir, '.worker.pid'), String(process.pid));
    writeFileSync(join(dataDir, '.worker.port'), String(port));
    return home;
  }

  test('reports the idle retire count alongside the settings in effect', async () => {
    const { home, dataDir } = isolatedHome('en');
    liveWorker(home, dataDir, liveHealth(
      { concurrency: 3, minWarmRuntimes: 1, idleTtlMs: 600000, maxJobsPerProcess: 50 },
      2,
    ));

    const out = await runDiagnose(home);
    expect(out.exitCode).toBe(0);
    // The count answers "is reclaim happening?"; the two settings answer "under
    // what policy?". Neither is useful without the other.
    expect(out.stdout).toContain('Idle retired');
    expect(out.stdout).toContain('after 600s');
    expect(out.stdout).toContain('keep warm 1');
  }, 20_000);

  test('says the reclaim is off instead of printing a 0ms threshold', async () => {
    const { home, dataDir } = isolatedHome('en');
    liveWorker(home, dataDir, liveHealth(
      { concurrency: 3, minWarmRuntimes: 1, idleTtlMs: 0, maxJobsPerProcess: 50 },
      0,
    ));

    const out = await runDiagnose(home);
    // "after 0s" would read as "retire immediately", the opposite of what 0 means.
    expect(out.stdout).toContain('Idle retired');
    expect(out.stdout).toContain('after off');
    expect(out.stdout).not.toContain('after 0s');
  }, 20_000);

  test('renders the same signals in Chinese', async () => {
    const { home, dataDir } = isolatedHome('zh');
    liveWorker(home, dataDir, liveHealth(
      { concurrency: 3, minWarmRuntimes: 2, idleTtlMs: 120000, maxJobsPerProcess: 50 },
      5,
    ));

    const out = await runDiagnose(home);
    // Missing zh keys would surface as `undefined` in the output.
    expect(out.stdout).toContain('空闲回收');
    expect(out.stdout).toContain('阈值 120s');
    expect(out.stdout).toContain('保留 2');
    expect(out.stdout).not.toContain('undefined');
  }, 20_000);

  test('stays silent when the Worker predates these fields', async () => {
    const { home, dataDir } = isolatedHome('en');
    // An older Worker reports no `acp` group at all. diagnose must not invent a
    // reading, and must not crash.
    liveWorker(home, dataDir, {
      memory: {
        workerSelfRssBytes: 120 * 1048576,
        acpSlots: [],
        acpAttributedSubtreeRssBytes: 0,
        mcpClientsSeen: [],
        rssMeasured: true,
      },
    });

    const out = await runDiagnose(home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain('Idle retired');
  }, 20_000);
});
