import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { extractArtifacts } from '../../src/jobs/artifacts';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

/** Create a turn and return its id. */
function newTurn(): number {
  db.upsertSessionRef({ session_id: 's', cwd: '/x', repo: '/x' });
  const seq = db.allocateNextTurnSeq('s');
  return db.createTurn({ session_id: 's', seq, cwd: '/x', repo: '/x' }).id;
}

/** Append a postToolUse event carrying { tool_input, tool_response }. */
function tool(turnId: number, toolName: string, input: unknown, response: unknown) {
  db.appendTurnEvent({
    turn_id: turnId,
    session_id: 's',
    hook_event_name: 'postToolUse',
    tool_name: toolName,
    payload_json: JSON.stringify({ tool_input: input, tool_response: response }),
  });
}

describe('extractArtifacts — facts (file mutations, §6.2)', () => {
  // Regression: error detection used to keyword-match the whole tool_response
  // JSON, so a green test run ("0 fail") and a file whose contents merely
  // mention "error" both produced bogus error signals — and the bogus signal
  // then suppressed the file-mutation fact. See benchmark/README.md D2.
  test('a green test run is not an error signal', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'bun test' }, { exit_status: 0, stdout: '138 pass, 0 fail' });
    const a = extractArtifacts(db, t);
    expect(a.test_signals).toEqual(['test PASS: 138 pass, 0 fail']);
    expect(a.error_signals).toEqual([]);
  });

  test('exit 0 stops keyword guessing over the payload', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'grep -rn error src' }, { exit_status: 0, stdout: 'src/a.ts: error handling' });
    expect(extractArtifacts(db, t).error_signals).toEqual([]);
  });

  test('a successful write whose response mentions no failures still yields a fact', () => {
    const t = newTurn();
    tool(t, 'write', { command: 'create', path: 'bunfig.toml' }, { success: true, note: 'no errors' });
    expect(extractArtifacts(db, t).facts).toContain('created bunfig.toml');
  });

  test('real failures are still reported', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'bun run typecheck' }, { exit_status: 2, stderr: 'TS2345: not assignable' });
    tool(t, 'shell', { command: 'bun test' }, { exit_status: 1, stdout: '3 pass, 2 fail' });
    const a = extractArtifacts(db, t);
    expect(a.error_signals.length).toBe(2);
    expect(a.error_signals[0]).toContain('TS2345');
    expect(a.test_signals).toContain('test FAIL: 3 pass, 2 fail');
  });

  test('write-tool commands map to created / modified facts', () => {
    const t = newTurn();
    tool(t, 'write', { command: 'create', path: 'src/a.ts' }, 'File created');
    tool(t, 'write', { command: 'strReplace', path: 'src/b.ts' }, 'File updated');
    const a = extractArtifacts(db, t);
    expect(a.facts).toContain('created src/a.ts');
    expect(a.facts).toContain('modified src/b.ts');
  });

  test('command-less write / delete tools fall back to tool-name detection', () => {
    const t = newTurn();
    tool(t, 'fsWrite', { path: 'src/c.ts', text: '...' }, 'ok');
    tool(t, 'fsDelete', { path: 'src/d.ts' }, 'ok');
    const a = extractArtifacts(db, t);
    expect(a.facts).toContain('wrote src/c.ts');
    expect(a.facts).toContain('deleted src/d.ts');
  });

  test('a mere read is NOT a mutation fact but IS in files_touched', () => {
    const t = newTurn();
    tool(t, 'fsRead', { path: 'src/read-only.ts' }, 'contents...');
    const a = extractArtifacts(db, t);
    expect(a.files_touched).toContain('src/read-only.ts');
    expect(a.facts.some((f) => f.includes('src/read-only.ts'))).toBe(false);
  });

  test('a failed write produces no mutation fact', () => {
    const t = newTurn();
    tool(t, 'write', { command: 'create', path: 'src/fail.ts' }, 'Error: permission denied');
    const a = extractArtifacts(db, t);
    expect(a.facts.some((f) => f.includes('src/fail.ts'))).toBe(false);
  });

  test('facts are deduped', () => {
    const t = newTurn();
    tool(t, 'write', { command: 'create', path: 'src/dup.ts' }, 'ok');
    tool(t, 'write', { command: 'create', path: 'src/dup.ts' }, 'ok');
    const a = extractArtifacts(db, t);
    expect(a.facts.filter((f) => f === 'created src/dup.ts').length).toBe(1);
  });
});

describe('extractArtifacts — decision_signals (VCS / deps)', () => {
  test('git commit and dependency install are recorded', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'git commit -m "feat: x"' }, { exit_status: 0 });
    tool(t, 'shell', { command: 'npm install lodash' }, { exit_status: 0 });
    const a = extractArtifacts(db, t);
    expect(a.decision_signals.some((d) => d.startsWith('git commit'))).toBe(true);
    expect(a.decision_signals.some((d) => d.includes('npm install lodash'))).toBe(true);
  });

  test('a plain test command is a test signal, not a decision', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'bun test' }, { exit_status: 0 });
    const a = extractArtifacts(db, t);
    expect(a.decision_signals.length).toBe(0);
    expect(a.test_signals.length).toBeGreaterThan(0);
  });

  test('a failed VCS command is not a committed decision', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'git push origin main' }, { exit_status: 1 });
    const a = extractArtifacts(db, t);
    expect(a.decision_signals.length).toBe(0);
  });

  test('decision_signals persist to turn_artifacts (truth layer)', () => {
    const t = newTurn();
    tool(t, 'shell', { command: 'git checkout -b feature/x' }, { exit_status: 0 });
    extractArtifacts(db, t);
    const stored = db.getTurnArtifacts(t);
    expect(stored).not.toBeNull();
    const decisions = JSON.parse(stored!.decision_signals_json) as string[];
    expect(decisions.some((d) => d.includes('git checkout'))).toBe(true);
  });
});
