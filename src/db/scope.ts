/** Topic scope key derivation: repo > cwd > __global__. */

import { resolve, normalize } from 'path';
import { realpathSync } from 'fs';

function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  let abs = resolve(trimmed);

  try {
    abs = realpathSync.native(abs);
  } catch {
    // Missing or inaccessible — keep the resolved-but-not-real form so callers
    // still get a stable key.
  }

  const n = normalize(abs);
  if (n.length > 1 && n.endsWith('/')) return n.slice(0, -1);
  return n;
}

export function computeScopeKey(
  repo: string | null | undefined,
  cwd: string | null | undefined,
): string {
  const r = repo ? normalizePathInput(repo) : '';
  if (r) return r;
  const c = cwd ? normalizePathInput(cwd) : '';
  if (c) return `cwd:${c}`;
  return '__global__';
}

/**
 * Enclosing git repo root, or null. The single implementation, colocated with
 * `computeScopeKey` because its result is the scope key's first component — if
 * ingest, MCP authorization and the bootstrap injector ever derive it
 * differently, memories are silently written to one scope and read from another.
 */
export function detectRepo(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {
    // git missing / not a repo — caller falls back to cwd-based scope.
  }
  return null;
}
