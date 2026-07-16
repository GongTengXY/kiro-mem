import { describe, expect, test } from 'bun:test';
import { MissingSearchScopeError, resolveScopeKey } from '../../src/server/mcp-scope';
import { computeScopeKey } from '../../src/db';

/**
 * Design §10.2: MCP `search` defaults to the current Agent's cwd (hard-scoped)
 * and only an explicit `all_scopes` opts into a global browse. A bare search
 * must NEVER return undefined (which would leak across every workspace).
 */
describe('resolveScopeKey (MCP search scope, §10.2)', () => {
  const inRepoA = { detectRepo: () => '/repoA' as string | null };
  const noRepo = { detectRepo: () => null };

  test('all_scopes:true is the ONLY path that returns undefined (global browse)', () => {
    expect(resolveScopeKey({ all_scopes: true }, inRepoA)).toBeUndefined();
    // all_scopes wins even if repo/cwd are also present.
    expect(resolveScopeKey({ all_scopes: true, repo: '/repoB', cwd: '/x' }, inRepoA)).toBeUndefined();
  });

  test('default without an authoritative session scope fails closed', () => {
    expect(() => resolveScopeKey({}, inRepoA)).toThrow(MissingSearchScopeError);
  });

  test('explicit repo filter takes precedence over detected cwd repo', () => {
    const key = resolveScopeKey({ repo: '/repoB' }, inRepoA);
    expect(key).toBe(computeScopeKey('/repoB', null));
  });

  test('explicit cwd filter detects and uses its git repo root', () => {
    const key = resolveScopeKey(
      { cwd: '/repoC/sub' },
      { detectRepo: (cwd) => (cwd === '/repoC/sub' ? '/repoC' : null) },
    );
    expect(key).toBe(computeScopeKey('/repoC', '/repoC/sub'));
  });

  test('explicit non-git cwd uses a cwd-prefixed scope', () => {
    const key = resolveScopeKey({ cwd: '/loose/dir' }, noRepo);
    expect(key).toBe(computeScopeKey(null, '/loose/dir'));
    expect(key!.startsWith('cwd:')).toBe(true);
  });
});

describe('resolveScopeKey — sessionScope precedence (P3)', () => {
  test('default uses the active session scope', () => {
    const key = resolveScopeKey({}, {
      sessionScope: () => 'SESSION_SCOPE',
      detectRepo: () => null,
    });
    expect(key).toBe('SESSION_SCOPE');
  });

  test('fails closed when the active session has no recorded scope', () => {
    expect(() => resolveScopeKey({}, { sessionScope: () => undefined })).toThrow(
      MissingSearchScopeError,
    );
  });

  test('explicit repo/cwd args still win over the session scope', () => {
    const key = resolveScopeKey({ repo: '/repoX' }, { sessionScope: () => 'SESSION_SCOPE' });
    expect(key).toBe(computeScopeKey('/repoX', null));
  });

  test('all_scopes still returns undefined regardless of session scope', () => {
    expect(resolveScopeKey({ all_scopes: true }, { sessionScope: () => 'SESSION_SCOPE' })).toBeUndefined();
  });
});
