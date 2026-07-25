import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
