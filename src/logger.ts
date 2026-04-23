import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './config';

const logsDir = join(getDataDir(), 'logs');
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

export function logError(context: string, err: unknown) {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString();
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  const line = `[${time}] [${context}] ${msg}\n`;
  try {
    appendFileSync(join(logsDir, `worker-${date}.log`), line);
  } catch {}
  console.error(`[kiro-mem] [${context}]`, msg);
}
