import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Create once, preserve across repair installs, and always enforce owner-only permissions. */
export function ensureLocalAuthToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, '.token');

  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf-8').trim();
    if (existing) {
      chmodSync(tokenPath, 0o600);
      return existing;
    }
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

/** Reads the on-disk token. Returns '' when absent, unreadable or blank. */
export function readLocalAuthToken(dataDir: string): string {
  try {
    return readFileSync(join(dataDir, '.token'), 'utf-8').trim();
  } catch {
    return '';
  }
}

export type AuthTokenState = 'ok' | 'missing' | 'empty' | 'weak' | 'insecure';

export interface AuthTokenInspection {
  state: AuthTokenState;
  ok: boolean;
  /** Permission bits when the file exists — never the token value itself. */
  mode?: number;
}

/**
 * Non-destructive token check for `kiro-mem diagnose`. Reports what is wrong
 * with the credential without ever returning or logging it.
 */
export function inspectLocalAuthToken(dataDir: string): AuthTokenInspection {
  const tokenPath = join(dataDir, '.token');
  if (!existsSync(tokenPath)) return { state: 'missing', ok: false };

  let raw: string;
  let mode: number;
  try {
    raw = readFileSync(tokenPath, 'utf-8').trim();
    mode = statSync(tokenPath).mode & 0o777;
  } catch {
    return { state: 'missing', ok: false };
  }

  if (!raw) return { state: 'empty', ok: false, mode };
  if (!/^[a-f0-9]{64}$/.test(raw)) return { state: 'weak', ok: false, mode };
  if (mode !== 0o600) return { state: 'insecure', ok: false, mode };
  return { state: 'ok', ok: true, mode };
}
