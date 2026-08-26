import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './config';

function formatLogValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function logError(context: string, err: unknown) {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString();
  const msg = formatLogValue(err);
  const line = `[${time}] [${context}] ${msg}\n`;
  const logsDir = join(getDataDir(), 'logs');
  try {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, `worker-${date}.log`), line);
  } catch {}
  console.error(`[kiro-mem] [${context}]`, msg);
}
