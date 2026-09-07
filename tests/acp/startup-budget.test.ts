/**
 * The handshake budget actually governs the handshake.
 *
 * Both steps used to carry literals (`initialize` 15000, `session/new` 20000) that
 * no config could reach. That is not a throughput setting: a cold `kiro-cli acp`
 * was measured from ~2s to over 20s, and a handshake that lost the race left the
 * turn as a `quality=fallback` Observation with no model summary.
 *
 * So the assertions check the number in the timeout message — a budget that is
 * plumbed but ignored looks identical to a working one until someone raises it.
 * The transport is swapped the way `pool-subprocess.test.ts` does it: a bash
 * wrapper that ignores its args and `exec`s a stub agent.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ACPPool } from '../../src/acp/pool';
import { ACPRuntime } from '../../src/acp/runtime';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Closed before the temp dir goes: these are real processes, deliberately left
  // waiting.
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An executable that answers `initialize` and then, optionally, nothing else. */
function stubCli(mode: 'silent' | 'stall-session-new'): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-startup-'));
  dirs.push(dir);

  const agent = join(dir, 'agent.ts');
  writeFileSync(
    agent,
    mode === 'silent'
      ? // Never reads, never answers: `initialize` can only time out.
        `await new Promise(() => {});\n`
      : `const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'stub', version: '0' } },
      }) + '\\n');
    }
    // session/new is deliberately never answered.
  }
}
await new Promise(() => {});
`,
  );

  const wrapper = join(dir, 'kiro-cli');
  // `exec`, so the spawned pid IS the stub: no grandchild survives a close.
  writeFileSync(wrapper, `#!/bin/bash\nexec bun run "${agent}"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function trackRuntime(runtime: ACPRuntime): ACPRuntime {
  closers.push(() => runtime.close());
  return runtime;
}

describe('ACP handshake budget', () => {
  test('initialize times out on the configured budget, not on a literal', async () => {
    const runtime = trackRuntime(
      new ACPRuntime({ kiroCliPath: stubCli('silent'), startupTimeoutMs: 300 }),
    );

    // 15000 here would mean the old literal is still in force.
    await expect(runtime.start()).rejects.toThrow('ACP request timeout: initialize (300ms)');
  }, 15_000);

  test('session/new shares the same budget', async () => {
    // Wide enough for the stub's own startup (bun compiling a .ts) to answer
    // `initialize`; the 300ms above only works for a stub that never answers.
    const runtime = trackRuntime(
      new ACPRuntime({ kiroCliPath: stubCli('stall-session-new'), startupTimeoutMs: 2000 }),
    );

    await runtime.start();
    // On its own 20000 literal this step was the next ceiling to hit.
    await expect(runtime.createSession()).rejects.toThrow(
      'ACP request timeout: session/new (2000ms)',
    );
  }, 15_000);

  test('the pool hands its budget to the runtimes it creates', async () => {
    const pool = new ACPPool({ kiroCliPath: stubCli('silent'), startupTimeoutMs: 300 });
    closers.push(() => pool.close());

    // The Worker never touches ACPRuntime directly, so a budget stopping at the
    // pool boundary would leave production on the default.
    await expect(pool.run('anything')).rejects.toThrow(
      'ACP request timeout: initialize (300ms)',
    );
  }, 15_000);
});
