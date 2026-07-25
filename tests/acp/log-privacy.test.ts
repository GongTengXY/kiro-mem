import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Compressor } from '../../src/compressor';
import { ACPCompressor } from '../../src/acp/compressor';

const dirs: string[] = [];
const originalDataDir = process.env.KIRO_MEMORY_DATA_DIR;

afterEach(() => {
  process.env.KIRO_MEMORY_DATA_DIR = originalDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readLogs(dir: string): string {
  const logs = join(dir, 'logs');
  try { return readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf-8')).join('\n'); }
  catch { return ''; }
}

describe('compressor log privacy', () => {
  test('test compressor parse failure logs metadata without raw model output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-log-'));
    dirs.push(dir);
    process.env.KIRO_MEMORY_DATA_DIR = dir;
    const secret = 'SECRET_PARSE_MARKER_7f43';
    const stderr: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
    try {
      const compressor = new Compressor({ compress: async () => `${secret} invalid json` });
      await compressor.summarizeObservation({
        user_prompt: 'request', assistant_response: 'response',
        artifacts: { files_touched: [], commands: [], test_signals: [], error_signals: [], facts: [] },
      });
    } finally {
      console.error = original;
    }
    expect(stderr.join('\n')).not.toContain(secret);
    expect(readLogs(dir)).not.toContain(secret);
    expect(stderr.join('\n')).toContain('parse');
  });

  test('ACP repair exhaustion logs counts and sizes without raw output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-log-'));
    dirs.push(dir);
    process.env.KIRO_MEMORY_DATA_DIR = dir;
    const secret = 'SECRET_REPAIR_MARKER_19ab';
    const fakePool = {
      stats: { total: 1, busy: 0, queued: 0, restarts: 0, contaminations: 0 },
      run: async () => ({ text: `${secret} invalid json`, stopReason: 'end_turn' }),
      close: async () => {},
    };
    const stderr: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
    try {
      const compressor = new ACPCompressor({ maxRetries: 1 }, fakePool as any);
      await compressor.summarizeObservation({
        user_prompt: 'request', assistant_response: 'response',
        artifacts: { files_touched: [], commands: [], test_signals: [], error_signals: [], facts: [] },
      });
    } finally {
      console.error = original;
    }
    expect(stderr.join('\n')).not.toContain(secret);
    expect(readLogs(dir)).not.toContain(secret);
    expect(stderr.join('\n')).toContain('repair-exhausted');
  });
});
