import { describe, expect, test, afterEach } from 'bun:test';
import { resolve } from 'path';
import { ACPClient } from '../../src/acp/client';
import { ACPRuntime, ACPContaminationError } from '../../src/acp/runtime';

const FAKE_SERVER = resolve(import.meta.dir, 'fake-acp-server.ts');

describe('ACPClient', () => {
  let client: ACPClient;

  afterEach(async () => {
    if (client) await client.close();
  });

  test('request/response routing works', async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    client = new ACPClient({
      command: 'bun',
      args: ['run', FAKE_SERVER],
      onNotification: (method, params) => notifications.push({ method, params }),
    });
    client.start();

    const result = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    }) as { agentInfo: { name: string } };

    expect(result.agentInfo.name).toBe('fake-acp');
  });

  test('notifications are dispatched', async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    client = new ACPClient({
      command: 'bun',
      args: ['run', FAKE_SERVER],
      onNotification: (method, params) => notifications.push({ method, params }),
    });
    client.start();

    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await client.request('session/new', { cwd: '/tmp', mcpServers: [] });
    await client.request('session/prompt', {
      sessionId: 'test-session-001',
      prompt: [{ type: 'text', text: 'echo:hello' }],
    });

    // Wait a tick for notifications to arrive
    await Bun.sleep(50);

    const chunks = notifications.filter(
      (n) => n.method === 'session/update' &&
        (n.params as any).update?.sessionUpdate === 'agent_message_chunk',
    );
    expect(chunks.length).toBe(1);
    expect((chunks[0]!.params as any).update.content.text).toBe('hello');
  });

  test('timeout rejects pending request', async () => {
    client = new ACPClient({
      command: 'bun',
      args: ['-e', 'await Bun.sleep(999999)'], // never responds
    });
    client.start();

    await expect(
      client.request('initialize', {}, 200),
    ).rejects.toThrow('timeout');
  });

  test('error response rejects with message', async () => {
    client = new ACPClient({
      command: 'bun',
      args: ['run', FAKE_SERVER],
    });
    client.start();

    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });

    await expect(
      client.request('unknown/method', {}),
    ).rejects.toThrow('Method not found');
  });
});

describe('ACPRuntime', () => {
  let runtime: ACPRuntime;

  afterEach(async () => {
    if (runtime) await runtime.close();
  });

  test('full flow: start → createSession → prompt → collect text', async () => {
    runtime = createFakeRuntime();
    const initResult = await runtime.start();
    expect(initResult.agentInfo.name).toBe('fake-acp');

    const sessionId = await runtime.createSession('/tmp');
    expect(sessionId).toBe('test-session-001');

    const result = await runtime.prompt('echo:test output');
    expect(result.text).toBe('test output');
  });

  test('maxOutputBytes truncates output', async () => {
    runtime = createFakeRuntime({ maxOutputBytes: 5 });
    await runtime.start();
    await runtime.createSession();

    // Should throw because output exceeds the byte limit
    await expect(
      runtime.prompt('echo:this is longer than 5 bytes'),
    ).rejects.toThrow('exceeded');
  });

  test('tool_call update marks runtime contaminated and rejects prompt', async () => {
    runtime = createFakeRuntime();
    await runtime.start();
    await runtime.createSession();

    let caught: unknown;
    try {
      await runtime.prompt('tool:read_file');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ACPContaminationError);
    expect((caught as ACPContaminationError).toolEventType).toBe('tool_call');
    expect((caught as ACPContaminationError).toolName).toBe('read_file');

    // Runtime stays in fatal state — alive must report false and subsequent
    // calls must reject without ever reaching the agent.
    expect(runtime.isContaminated).toBe(true);
    expect(runtime.alive).toBe(false);
    await expect(runtime.prompt('echo:still alive?')).rejects.toBeInstanceOf(ACPContaminationError);
  });

  test('tool_call contamination takes precedence over output truncation', async () => {
    runtime = createFakeRuntime({ maxOutputBytes: 1 });
    await runtime.start();
    await runtime.createSession();
    // tool:* path emits no chunks, so the contamination path is hit first.
    await expect(runtime.prompt('tool:write_file')).rejects.toBeInstanceOf(ACPContaminationError);
  });
});

/**
 * Helper: build an ACPRuntime that runs the fake ACP server instead of
 * `kiro-cli`. We can't pass custom args through ACPRuntime (it hardcodes
 * `['acp']`), so we drop a tiny bash wrapper next to this test that ignores
 * its CLI args and execs the fake server. The wrapper is regenerated on
 * every test run so its FAKE_SERVER path always matches the local checkout.
 */
function createFakeRuntime(opts?: { maxOutputBytes?: number }): ACPRuntime {
  const wrapperScript = resolve(import.meta.dir, 'fake-acp-wrapper.sh');
  const { writeFileSync, chmodSync } = require('fs');
  writeFileSync(wrapperScript, `#!/bin/bash\nexec bun run "${FAKE_SERVER}"\n`);
  chmodSync(wrapperScript, 0o755);

  return new ACPRuntime({
    kiroCliPath: wrapperScript,
    kiroHome: '',
    timeoutMs: 5000,
    maxOutputBytes: opts?.maxOutputBytes ?? 16384,
  });
}
