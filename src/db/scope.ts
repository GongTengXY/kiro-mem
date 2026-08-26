/** Topic scope key derivation: repo > cwd > __global__. */

import { resolve, normalize } from 'path';
import { realpathSync } from 'fs';

/** Resolve + realpath + normalize a path to a stable canonical form. */
function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  let abs = resolve(trimmed);

  try {
    abs = realpathSync.native(abs);
  } catch {
    // Path doesn't exist or is inaccessible — keep the resolved-but-not-real
    // form so callers still get a stable key.
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
 * Detect the enclosing git repo root for a directory, or null.
 *
 * The SINGLE implementation, deliberately colocated with `computeScopeKey`:
 * whatever this returns becomes the first component of the scope key, so the
 * ingest path (which freezes `scope_key` at write time), the MCP authorization
 * layer and the bootstrap injector must all derive it identically. Three
 * independent copies meant any drift would silently write memories into one
 * scope and read them from another — a workspace whose memory appears empty,
 * with nothing logged.
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
