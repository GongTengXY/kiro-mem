/**
 * Viewer client logic (plan §10.3, the parts that need no DOM).
 *
 * These modules are deliberately DOM-free so the Feed's merge rules, the token
 * handover and the SSE framing can be asserted directly rather than inferred from
 * a rendered page.
 */

import { describe, test, expect } from 'bun:test';
import type { ViewerObservationCard } from '../../src/server/viewer-types';
import { applyPin, compareCards, formatBytes, formatTime, mergeCards, removeCard, scopeLabel } from '../../src/ui/merge';
import { bootstrapSession, clearSession, parseLaunchFragment, rememberScope } from '../../src/ui/token';
import { backoffDelay, parseSseChunk } from '../../src/ui/stream';

function card(over: Partial<ViewerObservationCard> & { id: number }): ViewerObservationCard {
  return {
    scopeKey: '/proj/a',
    title: `Card ${over.id}`,
    memoryType: 'change',
    quality: 'normal',
    pinned: false,
    summary: '',
    outcome: null,
    nextSteps: null,
    turnStoppedAt: '2026-08-15T10:00:00.000Z',
    turnId: over.id,
    sessionId: 's1',
    turnSeq: over.id,
    files: [],
    concepts: [],
    evidence: [],
    counts: { files: 0, concepts: 0, evidence: 0 },
    scores: { importance: 0, confidence: 0, unresolved: 0 },
    ...over,
  };
}

/** Minimal in-memory Storage, so the token tests need no browser. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

describe('Feed merge (pagination + SSE)', () => {
  test('dedupes by id, keeps the fresher copy, and stays in stable order', () => {
    const page = [
      card({ id: 3, turnStoppedAt: '2026-08-15T12:00:00.000Z' }),
      card({ id: 2, turnStoppedAt: '2026-08-15T11:00:00.000Z' }),
    ];
    // The SSE-driven refetch returns #3 again, now pinned, plus a new #4.
    const live = [
      card({ id: 4, turnStoppedAt: '2026-08-15T13:00:00.000Z' }),
      card({ id: 3, turnStoppedAt: '2026-08-15T12:00:00.000Z', pinned: true }),
    ];

    const merged = mergeCards(page, live, { scopeKey: '/proj/a' });
    expect(merged.map((c) => c.id)).toEqual([4, 3, 2]);
    expect(merged.filter((c) => c.id === 3).length).toBe(1);
    expect(merged.find((c) => c.id === 3)!.pinned).toBe(true);
  });

  test('same timestamp falls back to id desc, so the order cannot wobble', () => {
    const same = '2026-08-15T10:00:00.000Z';
    const merged = mergeCards([], [card({ id: 1, turnStoppedAt: same }), card({ id: 9, turnStoppedAt: same })]);
    expect(merged.map((c) => c.id)).toEqual([9, 1]);
    expect(compareCards(card({ id: 9, turnStoppedAt: same }), card({ id: 1, turnStoppedAt: same }))).toBeLessThan(0);
  });

  test('a late response from the previous workspace cannot leak into the new one', () => {
    const current = [card({ id: 1, scopeKey: '/proj/new' })];
    const stale = [card({ id: 2, scopeKey: '/proj/old' })];
    expect(mergeCards(current, stale, { scopeKey: '/proj/new' }).map((c) => c.id)).toEqual([1]);
    // All-workspace browsing is the one mode where both belong on screen.
    expect(mergeCards(current, stale, { allScopes: true }).map((c) => c.id)).toEqual([2, 1]);
  });

  test('delete removes exactly one card; pin toggles without a refetch', () => {
    const cards = [card({ id: 1 }), card({ id: 2 })];
    expect(removeCard(cards, 1).map((c) => c.id)).toEqual([2]);
    expect(removeCard(cards, 99).length).toBe(2);
    expect(applyPin(cards, 2, true).find((c) => c.id === 2)!.pinned).toBe(true);
    expect(applyPin(cards, 2, true).find((c) => c.id === 1)!.pinned).toBe(false);
  });

  test('formatters stay defensive about bad input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatTime(null)).toBe('—');
    expect(formatTime('not-a-date')).toBe('not-a-date');
    expect(scopeLabel('/Users/me/code/kiro-memory')).toBe('kiro-memory');
    expect(scopeLabel('cwd:/Users/me/scratch')).toBe('scratch');
    expect(scopeLabel('__global__')).toBe('__global__');
  });
});

describe('token handover', () => {
  test('reads the fragment, stores it for this tab, and scrubs the URL', () => {
    const storage = fakeStorage();
    const replaced: string[] = [];
    const location = { hash: '#token=abc123&scope=%2Fproj%2Fa', pathname: '/ui', search: '' } as Location;
    const history = { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } as unknown as History;

    const session = bootstrapSession(location, history, storage);
    expect(session.token).toBe('abc123');
    expect(session.scopeKey).toBe('/proj/a');
    // The credential must not survive in the address bar or the history entry.
    expect(replaced).toEqual(['/ui']);
    expect(replaced[0]).not.toContain('abc123');

    // A reload has no fragment and recovers from this tab's storage.
    const reloaded = bootstrapSession(
      { hash: '', pathname: '/ui', search: '' } as Location,
      history,
      storage,
    );
    expect(reloaded.token).toBe('abc123');
    expect(reloaded.scopeKey).toBe('/proj/a');

    // Ending the session (401, or closing the tab) makes it unrecoverable.
    clearSession(storage);
    expect(bootstrapSession({ hash: '', pathname: '/ui', search: '' } as Location, history, storage).token).toBe('');
  });

  test('a fresh tab with no fragment and empty storage has no credential', () => {
    const session = bootstrapSession(
      { hash: '', pathname: '/ui', search: '' } as Location,
      { replaceState: () => undefined } as unknown as History,
      fakeStorage(),
    );
    expect(session.token).toBe('');
    expect(session.scopeKey).toBeNull();
  });

  test('a fresh CLI launch defaults to all workspaces and clears stale scope state', () => {
    const storage = fakeStorage();
    rememberScope(storage, '/proj/old');
    const session = bootstrapSession(
      { hash: '#token=fresh', pathname: '/ui', search: '' } as Location,
      { replaceState: () => undefined } as unknown as History,
      storage,
    );
    expect(session).toEqual({ token: 'fresh', scopeKey: null });
    expect(storage.getItem('kiro-mem.viewer.scope')).toBeNull();
  });

  test('fragment parsing tolerates junk and url-encoding', () => {
    expect(parseLaunchFragment('')).toEqual({ token: '', scopeKey: null });
    expect(parseLaunchFragment('#nonsense')).toEqual({ token: '', scopeKey: null });
    expect(parseLaunchFragment('token=t&scope=cwd%3A%2Ftmp%2Fx')).toEqual({ token: 't', scopeKey: 'cwd:/tmp/x' });
  });

  test('remembering a scope is per tab and clearable', () => {
    const storage = fakeStorage();
    rememberScope(storage, '/proj/b');
    expect(storage.getItem('kiro-mem.viewer.scope')).toBe('/proj/b');
    rememberScope(storage, null);
    expect(storage.getItem('kiro-mem.viewer.scope')).toBeNull();
  });
});

describe('SSE framing and reconnect policy', () => {
  test('parses whole frames only and keeps the partial tail buffered', () => {
    const first = parseSseChunk('event: initial_state\ndata: {"type":"initial_state"}\n\nevent: heart');
    expect(first.events).toEqual([{ type: 'initial_state' } as never]);
    expect(first.rest).toBe('event: heart');

    const second = parseSseChunk(`${first.rest}beat\ndata: {"type":"heartbeat"}\n\n`);
    expect(second.events.map((e) => e.type)).toEqual(['heartbeat']);
    expect(second.rest).toBe('');
  });

  test('comment frames and malformed data never reach the UI as events', () => {
    expect(parseSseChunk(': kiro-mem viewer stream\n\n').events).toEqual([]);
    expect(parseSseChunk('data: {not json}\n\n').events).toEqual([]);
  });

  test('several frames in one chunk are delivered in order', () => {
    const chunk =
      'data: {"type":"observation_created","observationId":1}\n\n' +
      'data: {"type":"observation_deleted","observationId":2}\n\n';
    expect(parseSseChunk(chunk).events.map((e) => e.type)).toEqual(['observation_created', 'observation_deleted']);
  });

  test('backoff grows and is capped so a down Worker is not hammered', () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(4)).toBe(8000);
    expect(backoffDelay(20)).toBe(15_000);
  });
});
