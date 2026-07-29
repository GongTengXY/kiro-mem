#!/usr/bin/env bun
/**
 * stop hook: notify Worker that the current turn has ended.
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
  const response = await fetch(`http://127.0.0.1:${port}/events/stop`, {
    method: 'POST', headers, body: input,
    signal: AbortSignal.timeout(700),
  });
  // Capture is best-effort, but a dropped raw event is unrecoverable, so record
  // that it happened (metadata only) instead of failing silently.
  if (!response.ok) recordCaptureMiss(DATA_DIR, 'stop', 'rejected', response.status);
} catch (error) {
  recordCaptureMiss(DATA_DIR, 'stop', classifyCaptureError(error));
}
