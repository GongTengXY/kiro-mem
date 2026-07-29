/**
 * §6 — Truth Layer size bounds.
 *
 * `turn_events` is append-only and has no retention policy, so anything the
 * write path accepts it accepts forever. These tests pin the two invariants
 * that make that safe: no single event can store an unbounded payload, and no
 * single turn can grow the database without limit. Both must truncate VISIBLY —
 * a silently shortened tool response is indistinguishable from a tool that
 * simply printed less.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, capEventPayload } from '../../src/db';
import { extractArtifacts } from '../../src/jobs/artifacts';
import { openInMemoryDB } from '../support/tmp-db';

const STRING_CAP = 32 * 1024;
const TURN_CAP = 4 * 1024 * 1024;

let db: MemoryDB;

function seedTurn(sessionId = 'S1'): number {
  db.upsertSessionRef({ session_id: sessionId, cwd: '/proj', repo: '/proj' });
  const seq = db.allocateNextTurnSeq(sessionId);
  return db.createTurn({ session_id: sessionId, seq, cwd: '/proj', repo: '/proj' }).id;
}

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

describe('capEventPayload', () => {
  test('a small payload is stored byte-for-byte', () => {
    const json = JSON.stringify({ tool_response: 'ok' });
    const r = capEventPayload(json, 0);
    expect(r.payload).toBe(json);
    expect(r.truncated).toBe(false);
    expect(r.originalSize).toBe(Buffer.byteLength(json));
  });

  test('an oversized string leaf is truncated and marked', () => {
    const huge = 'x'.repeat(STRING_CAP * 3);
    const r = capEventPayload(JSON.stringify({ tool_response: huge }), 0);
    expect(r.truncated).toBe(true);
    expect(r.payload).toContain('kiro-mem: truncated');
    expect(Buffer.byteLength(r.payload)).toBeLessThan(STRING_CAP + 512);
  });

  test('the original size is preserved even though the body is not', () => {
    const json = JSON.stringify({ tool_response: 'y'.repeat(STRING_CAP * 4) });
    const r = capEventPayload(json, 0);
    expect(r.originalSize).toBe(Buffer.byteLength(json));
    expect(Buffer.byteLength(r.payload)).toBeLessThan(r.originalSize);
  });

  test('object structure survives truncation, so extraction still has its fields', () => {
    const r = capEventPayload(
      JSON.stringify({
        tool_name: 'shell',
        tool_input: { command: 'bun test' },
        tool_response: 'z'.repeat(STRING_CAP * 2),
      }),
      0,
    );
    const parsed = JSON.parse(r.payload);
    expect(parsed.tool_name).toBe('shell');
    expect(parsed.tool_input.command).toBe('bun test');
    expect(typeof parsed.tool_response).toBe('string');
  });

  test('many oversized leaves collapse to a stub rather than a huge row', () => {
    const body: Record<string, string> = {};
    for (let i = 0; i < 40; i++) body[`f${i}`] = 'q'.repeat(STRING_CAP * 2);
    const r = capEventPayload(JSON.stringify(body), 0);
    const parsed = JSON.parse(r.payload);
    expect(parsed._kiro_mem_dropped).toContain('per-event cap');
    expect(parsed._kiro_mem_original_bytes).toBeGreaterThan(STRING_CAP);
  });

  test('once the turn budget is spent only a metadata stub is stored', () => {
    const r = capEventPayload(JSON.stringify({ tool_response: 'small' }), TURN_CAP);
    const parsed = JSON.parse(r.payload);
    expect(parsed._kiro_mem_dropped).toContain('turn payload budget');
    expect(r.truncated).toBe(true);
  });

  test('non-JSON text is still bounded instead of rejected', () => {
    const r = capEventPayload('not json '.repeat(200_000), 0);
    expect(Buffer.byteLength(r.payload)).toBeLessThanOrEqual(256 * 1024);
  });

  test('truncation cuts on a character boundary (no mojibake)', () => {
    // 3-byte chars: a naive byte slice would land mid-sequence.
    const r = capEventPayload(JSON.stringify({ text: '中'.repeat(STRING_CAP) }), 0);
    expect(() => JSON.parse(r.payload)).not.toThrow();
    expect(JSON.parse(r.payload).text).not.toContain('\uFFFD');
  });
});

describe('appendTurnEvent enforces the bounds', () => {
  test('a stored oversized payload is capped but payload_size stays truthful', () => {
    const turnId = seedTurn();
    const json = JSON.stringify({ tool_response: 'x'.repeat(STRING_CAP * 5) });
    const ev = db.appendTurnEvent({
      turn_id: turnId,
      session_id: 'S1',
      hook_event_name: 'postToolUse',
      tool_name: 'shell',
      payload_json: json,
    });

    expect(ev.payload_size).toBe(Buffer.byteLength(json));
    expect(Buffer.byteLength(ev.payload_json)).toBeLessThan(ev.payload_size);
    expect(ev.payload_json).toContain('kiro-mem: truncated');
  });

  test('artifacts extraction still works over a truncated payload', () => {
    const turnId = seedTurn('S2');
    db.appendTurnEvent({
      turn_id: turnId,
      session_id: 'S2',
      hook_event_name: 'postToolUse',
      tool_name: 'shell',
      payload_json: JSON.stringify({
        tool_name: 'shell',
        tool_input: { command: 'bun test' },
        tool_response: 'pass\n'.repeat(STRING_CAP),
      }),
    });

    const artifacts = extractArtifacts(db, turnId);
    expect(artifacts.tool_names).toContain('shell');
    expect(artifacts.commands.join(' ')).toContain('bun test');
    // stats reports the true ingested volume, not the stored volume.
    expect(artifacts.stats.total_payload_bytes).toBeGreaterThan(STRING_CAP);
  });

  test('turnPayloadBytes accumulates the original sizes', () => {
    const turnId = seedTurn('S3');
    db.appendTurnEvent({
      turn_id: turnId, session_id: 'S3', hook_event_name: 'postToolUse',
      payload_json: JSON.stringify({ a: 'x'.repeat(1000) }),
    });
    db.appendTurnEvent({
      turn_id: turnId, session_id: 'S3', hook_event_name: 'postToolUse',
      payload_json: JSON.stringify({ b: 'y'.repeat(1000) }),
    });
    expect(db.turnPayloadBytes(turnId)).toBeGreaterThan(2000);
  });

  test('a normal payload is stored unchanged', () => {
    const turnId = seedTurn('S4');
    const json = JSON.stringify({ tool_response: 'all good' });
    const ev = db.appendTurnEvent({
      turn_id: turnId, session_id: 'S4', hook_event_name: 'postToolUse', payload_json: json,
    });
    expect(ev.payload_json).toBe(json);
  });
});
