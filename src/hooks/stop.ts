#!/usr/bin/env bun
/**
 * stop hook: notify Worker that the current turn has ended.
 */
import { readFileSync } from 'fs';

const HOME = process.env.HOME || '~';
const DATA_DIR = process.env.KIRO_MEMORY_DATA_DIR || `${HOME}/.kiro-mem`;

function readToken(): string {
  try { return readFileSync(`${DATA_DIR}/.token`, 'utf-8').trim(); } catch { return ''; }
}
function readPort(): string {
  try { return readFileSync(`${DATA_DIR}/.worker.port`, 'utf-8').trim(); } catch { return '37778'; }
}

const input = await Bun.stdin.text();
const port = readPort();
const token = readToken();
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (token) headers['Authorization'] = `Bearer ${token}`;

try {
  await fetch(`http://127.0.0.1:${port}/events/stop`, {
    method: 'POST', headers, body: input,
    signal: AbortSignal.timeout(2000),
  });
} catch {}
