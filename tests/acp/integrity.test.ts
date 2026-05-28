import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRuntimeHome } from '../../src/acp/integrity';

const AGENT = 'kiro-mem-compressor';

describe('checkRuntimeHome', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiro-mem-integrity-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('reports error when kiroHome is empty', () => {
    const issues = checkRuntimeHome('', AGENT);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('not configured'))).toBe(true);
  });

  test('reports error when kiroHome does not exist', () => {
    const issues = checkRuntimeHome(join(dir, 'nope'), AGENT);
    expect(issues.some((i) => i.message.includes('does not exist'))).toBe(true);
  });

  test('reports error when agent file is missing', () => {
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.some((i) => i.message.includes('agent file missing'))).toBe(true);
  });

  test('reports error when tools is non-empty', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', `${AGENT}.json`),
      JSON.stringify({ name: AGENT, tools: ['read_file'] }),
    );
    writeFileSync(join(dir, `${AGENT}-prompt.md`), '# prompt');
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('tools: []'))).toBe(true);
  });

  test('reports error when name does not match', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', `${AGENT}.json`),
      JSON.stringify({ name: 'something-else', tools: [] }),
    );
    writeFileSync(join(dir, `${AGENT}-prompt.md`), '# prompt');
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.some((i) => i.message.includes('name mismatch'))).toBe(true);
  });

  test('reports error when prompt file is missing', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', `${AGENT}.json`),
      JSON.stringify({ name: AGENT, tools: [] }),
    );
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.some((i) => i.message.includes('prompt missing'))).toBe(true);
  });

  test('returns no errors when layout is correct', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', `${AGENT}.json`),
      JSON.stringify({ name: AGENT, tools: [] }),
    );
    writeFileSync(join(dir, `${AGENT}-prompt.md`), '# prompt');
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.filter((i) => i.severity === 'error').length).toBe(0);
  });

  test('reports error on invalid JSON', () => {
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', `${AGENT}.json`), '{not json');
    writeFileSync(join(dir, `${AGENT}-prompt.md`), '# prompt');
    const issues = checkRuntimeHome(dir, AGENT);
    expect(issues.some((i) => i.message.includes('unparseable'))).toBe(true);
  });
});
