import { describe, expect, test } from 'bun:test';
import { injectSessionId } from '../../src/hooks/session';

describe('injectSessionId (hook session_id compatibility fallback)', () => {
  test('injects session_id from the given id when the payload lacks it', () => {
    const out = injectSessionId(
      '{"hook_event_name":"userPromptSubmit","cwd":"/x","prompt":"hi"}',
      'sid-123',
    );
    const obj = JSON.parse(out);
    expect(obj.session_id).toBe('sid-123');
    // other fields preserved
    expect(obj.cwd).toBe('/x');
    expect(obj.prompt).toBe('hi');
    expect(obj.hook_event_name).toBe('userPromptSubmit');
  });

  test('preserves the official payload session_id', () => {
    const out = injectSessionId('{"session_id":"already","cwd":"/x"}', 'sid-123');
    expect(JSON.parse(out).session_id).toBe('already');
  });

  test('payload session_id remains authoritative when the environment differs', () => {
    const out = injectSessionId('{"session_id":"payload-id","cwd":"/x"}', 'env-id');
    expect(JSON.parse(out).session_id).toBe('payload-id');
  });

  test('does not replace a present but invalid payload session_id', () => {
    const out = injectSessionId('{"session_id":"","cwd":"/x"}', 'env-id');
    expect(JSON.parse(out).session_id).toBe('');
  });

  test('returns input unchanged when no session id is available', () => {
    // Pass '' (not undefined) — undefined would trigger the default param,
    // which reads process.env.KIRO_SESSION_ID (set when tests run inside Kiro).
    const raw = '{"cwd":"/x"}';
    expect(injectSessionId(raw, '')).toBe(raw);
  });

  test('returns input unchanged for non-JSON', () => {
    expect(injectSessionId('not json at all', 'sid')).toBe('not json at all');
  });

  test('does not treat a JSON array as an injectable object', () => {
    expect(injectSessionId('[1,2,3]', 'sid')).toBe('[1,2,3]');
  });

  test('defaults to process.env.KIRO_SESSION_ID', () => {
    const prev = process.env.KIRO_SESSION_ID;
    process.env.KIRO_SESSION_ID = 'env-sid';
    try {
      expect(JSON.parse(injectSessionId('{"cwd":"/x"}')).session_id).toBe('env-sid');
    } finally {
      if (prev === undefined) delete process.env.KIRO_SESSION_ID;
      else process.env.KIRO_SESSION_ID = prev;
    }
  });
});
