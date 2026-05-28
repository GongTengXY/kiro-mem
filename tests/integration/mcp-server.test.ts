import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { mkdtempSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

const PKG_ROOT = resolve(import.meta.dir, '../..');

let DATA_DIR: string;
let pkgVersion: string;

beforeAll(() => {
  DATA_DIR = mkdtempSync(`${tmpdir()}/kiro-mem-mcp-server-`);
  pkgVersion = JSON.parse(
    readFileSync(`${PKG_ROOT}/package.json`, 'utf-8'),
  ).version;
});

describe('MCP server handshake', () => {
  let proc: Subprocess | null = null;

  afterEach(() => {
    try {
      proc?.kill();
    } catch {}
    proc = null;
  });

  test('initialize returns protocolVersion and serverInfo.{name,version}', async () => {
    proc = spawn({
      cmd: ['bun', 'run', 'src/server/mcp-server.ts'],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KIRO_MEMORY_DATA_DIR: DATA_DIR,
      },
    });

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    const stdin = proc.stdin as any;
    stdin.write(request + '\n');
    stdin.flush?.();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const line = decoder.decode(value).trim().split('\n').find(Boolean);
    expect(line).toBeTruthy();

    const message = JSON.parse(line!) as {
      id: number;
      result?: {
        protocolVersion?: string;
        capabilities?: Record<string, unknown>;
        serverInfo?: { name?: string; version?: string };
      };
    };

    expect(message.id).toBe(1);
    expect(message.result?.protocolVersion).toBe('2025-03-26');
    expect(message.result?.capabilities?.tools).toEqual({});
    expect(message.result?.serverInfo?.name).toBe('kiro-mem');
    expect(message.result?.serverInfo?.version).toBe(pkgVersion);
  });
});
