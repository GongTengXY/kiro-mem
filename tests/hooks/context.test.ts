import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const HOOK = resolve(import.meta.dir, '../../src/hooks/context.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runHook(dataDir: string, cwd = '/tmp', pathOverride?: string) {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: ['bun', 'run', HOOK],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env,
      KIRO_MEMORY_DATA_DIR: dataDir,
      ...(pathOverride ? { PATH: pathOverride } : {}),
    },
  });
  proc.stdin.write(JSON.stringify({ cwd }));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, elapsedMs: performance.now() - started };
}

describe('agentSpawn context hook failure policy', () => {
  test('worker unreachable exits 0 quickly and never invokes service commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-hook-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, '.worker.port'), '1');

    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const marker = join(dir, 'service-command-called');
    for (const name of ['launchctl', 'systemctl', 'sleep']) {
      const script = join(binDir, name);
      writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
      chmodSync(script, 0o755);
    }

    const result = await runHook(dir, '/tmp', `${binDir}:${process.env.PATH}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test('worker reachable still emits bootstrap context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-hook-'));
    tempDirs.push(dir);
    const expected = '<kiro-mem-context>ready</kiro-mem-context>';
    const server = Bun.serve({ port: 0, fetch: () => new Response(expected) });
    writeFileSync(join(dir, '.worker.port'), String(server.port));
    try {
      const result = await runHook(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(expected);
    } finally {
      server.stop(true);
    }
  });
});
