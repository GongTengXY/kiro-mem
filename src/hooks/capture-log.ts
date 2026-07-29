/**
 * Capture observability for the best-effort ingest hooks (P0-3).
 *
 * Product semantics, stated explicitly: capture is BEST-EFFORT. Every write
 * hook gives the Worker at most ~700ms and then gives up, because a Kiro turn
 * must never be blocked by the memory system. That means a Worker restart, a
 * transient SQLITE_BUSY or a port change can drop a raw event — and unlike a
 * failed projection, a dropped input cannot be reconstructed later.
 *
 * We are not turning this into a guaranteed-delivery queue (a local spool would
 * bring its own privacy and capacity surface, which contradicts the "local and
 * light" positioning). What we DO owe the user is visibility: a silent gap is
 * indistinguishable from "nothing happened that turn".
 *
 * So each hook appends one metadata-only line here when a POST does not land.
 * No prompt text, no tool payload, no assistant response — only which hook, why
 * it failed, and when. The Worker's /health and `kiro-mem diagnose` surface a
 * 24h summary from this file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Only the three WRITE hooks are tracked. A failed `agentSpawn` bootstrap is a
 * missed injection, not lost data — nothing becomes unrecoverable — so counting
 * it here would blur what this metric means: raw facts that never made it into
 * the Truth Layer.
 */
export type CaptureHook = 'userPromptSubmit' | 'postToolUse' | 'stop';

/**
 * Why a capture attempt did not land. Deliberately coarse — enough to tell a
 * dead Worker apart from a rejecting Worker, without recording request content.
 */
export type CaptureMissReason =
  | 'unreachable' // connection refused / DNS / socket error — Worker not running
  | 'timeout' // hook budget elapsed before the Worker answered
  | 'rejected' // Worker answered with a non-2xx status
  | 'unknown';

export interface CaptureMiss {
  ts: string;
  hook: CaptureHook;
  reason: CaptureMissReason;
  /** HTTP status when `reason === 'rejected'`. */
  status?: number;
}

export interface CaptureMissSummary {
  total: number;
  byReason: Record<string, number>;
  byHook: Record<string, number>;
  latest: string | null;
}

/** Keep the file bounded: trim to KEEP_LINES once it exceeds MAX_LINES. */
const MAX_LINES = 400;
const KEEP_LINES = 200;

export function captureLogPath(dataDir: string): string {
  return join(dataDir, 'capture-misses.jsonl');
}

/**
 * Append one miss. Never throws: an observability write must not be the reason a
 * hook fails, and hooks run inside the user's turn.
 */
export function recordCaptureMiss(
  dataDir: string,
  hook: CaptureHook,
  reason: CaptureMissReason,
  status?: number,
): void {
  try {
    const path = captureLogPath(dataDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: CaptureMiss = { ts: new Date().toISOString(), hook, reason };
    if (status !== undefined) entry.status = status;
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    trimCaptureLog(path);
  } catch {
    // Deliberately silent.
  }
}

function trimCaptureLog(path: string): void {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    writeFileSync(path, `${lines.slice(-KEEP_LINES).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // Deliberately silent.
  }
}

/** Read a windowed summary. Returns zeros when the file is absent. */
export function readCaptureMisses(dataDir: string, withinHours = 24): CaptureMissSummary {
  const empty: CaptureMissSummary = { total: 0, byReason: {}, byHook: {}, latest: null };
  let raw: string;
  try {
    raw = readFileSync(captureLogPath(dataDir), 'utf-8');
  } catch {
    return empty;
  }

  const cutoff = Date.now() - withinHours * 3600_000;
  const summary: CaptureMissSummary = { total: 0, byReason: {}, byHook: {}, latest: null };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CaptureMiss;
    try {
      entry = JSON.parse(line) as CaptureMiss;
    } catch {
      continue;
    }
    const at = Date.parse(entry.ts);
    if (!Number.isFinite(at) || at < cutoff) continue;
    summary.total++;
    summary.byReason[entry.reason] = (summary.byReason[entry.reason] ?? 0) + 1;
    summary.byHook[entry.hook] = (summary.byHook[entry.hook] ?? 0) + 1;
    if (!summary.latest || entry.ts > summary.latest) summary.latest = entry.ts;
  }
  return summary;
}

/**
 * Classify a thrown fetch error into a coarse reason. Timeouts come through as
 * an AbortError from `AbortSignal.timeout`.
 */
export function classifyCaptureError(error: unknown): CaptureMissReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const message = error instanceof Error ? error.message : String(error);
  if (/refused|ECONNREFUSED|failed to connect|Unable to connect/i.test(message)) return 'unreachable';
  return 'unknown';
}
