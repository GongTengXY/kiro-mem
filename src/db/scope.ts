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
