/**
 * P0-3: capture is best-effort, so a dropped raw event must be VISIBLE.
 *
 * These tests pin the observability contract: hooks still exit 0 and stay
 * silent on stdout when the Worker is unreachable, but the miss is recorded
 * (metadata only — never prompt text, tool payloads or assistant responses) and
 * surfaces in a 24h summary.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  captureLogPath,
  classifyCaptureError,
  readCaptureMisses,
  recordCaptureMiss,
} from '../../src/hooks/capture-log';

const PKG_ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];

function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-capture-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('capture miss log', () => {
  test('records reason and hook, and summarises them', () => {
    const dir = tmpDataDir();
    recordCaptureMiss(dir, 'stop', 'unreachable');
    recordCaptureMiss(dir, 'stop', 'timeout');
    recordCaptureMiss(dir, 'postToolUse', 'rejected', 503);

    const summary = readCaptureMisses(dir);
    expect(summary.total).toBe(3);
    expect(summary.byHook).toEqual({ stop: 2, postToolUse: 1 });
    expect(summary.byReason).toEqual({ unreachable: 1, timeout: 1, rejected: 1 });
    expect(summary.latest).not.toBeNull();
  });

  test('an absent log reads as zero rather than throwing', () => {
    const summary = readCaptureMisses(tmpDataDir());
    expect(summary).toEqual({ total: 0, byReason: {}, byHook: {}, latest: null });
  });

  test('entries older than the window are excluded', () => {
    const dir = tmpDataDir();
    recordCaptureMiss(dir, 'stop', 'timeout');
    // Rewrite the single entry with an old timestamp.
    const path = captureLogPath(dir);
    const entry = JSON.parse(readFileSync(path, 'utf-8').trim());
    entry.ts = new Date(Date.now() - 48 * 3600_000).toISOString();
    Bun.write(path, `${JSON.stringify(entry)}\n`);

    expect(readCaptureMisses(dir, 24).total).toBe(0);
    expect(readCaptureMisses(dir, 72).total).toBe(1);
  });

  test('the log stays bounded instead of growing without limit', () => {
    const dir = tmpDataDir();
    for (let i = 0; i < 450; i++) recordCaptureMiss(dir, 'postToolUse', 'timeout');
    const lines = readFileSync(captureLogPath(dir), 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(400);
  });

  test('malformed lines are skipped, not fatal', () => {
    const dir = tmpDataDir();
    recordCaptureMiss(dir, 'stop', 'timeout');
    const path = captureLogPath(dir);
    Bun.write(path, `${readFileSync(path, 'utf-8')}not json\n`);
    expect(readCaptureMisses(dir).total).toBe(1);
  });

  test('classifyCaptureError maps abort to timeout and refusal to unreachable', () => {
    const abort = new Error('aborted');
    abort.name = 'TimeoutError';
    expect(classifyCaptureError(abort)).toBe('timeout');
    expect(classifyCaptureError(new Error('connection refused'))).toBe('unreachable');
    expect(classifyCaptureError(new Error('something else'))).toBe('unknown');
  });
});

describe('write hooks record a miss when the Worker is unreachable', () => {
  // Port 1 is privileged and nothing listens there, so the POST fails fast.
  async function runHook(script: string, dataDir: string, payload: unknown) {
    await Bun.write(join(dataDir, '.worker.port'), '1');
    const proc = Bun.spawn({
      cmd: ['bun', 'run', script],
      cwd: PKG_ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, KIRO_MEMORY_DATA_DIR: dataDir, KIRO_SESSION_ID: 'sess-capture' },
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout };
  }

  test('stop hook: exits 0, prints nothing, records the miss', async () => {
    const dir = tmpDataDir();
    const { exitCode, stdout } = await runHook('src/hooks/stop.ts', dir, {
      session_id: 'sess-capture',
      assistant_response: 'CAPTURE_BODY_MARKER',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');

    const summary = readCaptureMisses(dir);
    expect(summary.total).toBe(1);
    expect(summary.byHook.stop).toBe(1);

    // Metadata only: the log must never carry request content.
    expect(readFileSync(captureLogPath(dir), 'utf-8')).not.toContain('CAPTURE_BODY_MARKER');
  }, 10000);

  test('userPromptSubmit hook records the miss', async () => {
    const dir = tmpDataDir();
    const { exitCode } = await runHook('src/hooks/prompt-save.ts', dir, {
      session_id: 'sess-capture',
      cwd: '/tmp',
      prompt: 'CAPTURE_PROMPT_MARKER',
    });
    expect(exitCode).toBe(0);
    expect(readCaptureMisses(dir).byHook.userPromptSubmit).toBe(1);
    expect(readFileSync(captureLogPath(dir), 'utf-8')).not.toContain('CAPTURE_PROMPT_MARKER');
  }, 10000);

  test('postToolUse hook records the miss', async () => {
    const dir = tmpDataDir();
    const { exitCode } = await runHook('src/hooks/observation.ts', dir, {
      session_id: 'sess-capture',
      tool_name: 'shell',
      tool_input: { command: 'CAPTURE_TOOL_MARKER' },
      tool_response: '',
    });
    expect(exitCode).toBe(0);
    expect(readCaptureMisses(dir).byHook.postToolUse).toBe(1);
    expect(readFileSync(captureLogPath(dir), 'utf-8')).not.toContain('CAPTURE_TOOL_MARKER');
  }, 10000);

  test('agentSpawn failure is NOT counted as a capture miss (no data lost)', async () => {
    const dir = tmpDataDir();
    const { exitCode, stdout } = await runHook('src/hooks/context.ts', dir, { cwd: '/tmp' });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(captureLogPath(dir))).toBe(false);
  }, 10000);
});
