#!/usr/bin/env bun
/**
 * postToolUse hook: forward tool observation to Worker with session_id.
 */
import { readFileSync } from 'fs';
import { injectSessionId } from './session';
import { classifyCaptureError, recordCaptureMiss } from './capture-log';

const HOME = process.env.HOME || '~';
const DATA_DIR = process.env.KIRO_MEMORY_DATA_DIR || `${HOME}/.kiro-mem`;

function readToken(): string {
  try { return readFileSync(`${DATA_DIR}/.token`, 'utf-8').trim(); } catch { return ''; }
}
function readPort(): string {
  try { return readFileSync(`${DATA_DIR}/.worker.port`, 'utf-8').trim(); } catch { return '37778'; }
}

const input = injectSessionId(await Bun.stdin.text());
const port = readPort();
const token = readToken();
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (token) headers['Authorization'] = `Bearer ${token}`;

try {
  const response = await fetch(`http://127.0.0.1:${port}/events/observation`, {
    method: 'POST', headers, body: input,
    signal: AbortSignal.timeout(700),
  });
  // 200 with {skipped:true} is a normal filter decision, not a miss; only a
  // non-2xx means the Worker refused or failed to store the tool event.
  if (!response.ok) recordCaptureMiss(DATA_DIR, 'postToolUse', 'rejected', response.status);
} catch (error) {
  recordCaptureMiss(DATA_DIR, 'postToolUse', classifyCaptureError(error));
}
