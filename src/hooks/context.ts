#!/usr/bin/env bun
/**
 * agentSpawn hook: fetch bootstrap context without ever managing the Worker —
 * launchd/systemd owns process keepalive.
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

try {
  const input = await Bun.stdin.text();
  const event = JSON.parse(input) as { cwd?: unknown };
  const cwd = typeof event.cwd === 'string' ? event.cwd : '';
  const port = readPort();
  const token = readToken();
  const url = `http://127.0.0.1:${port}/context/bootstrap?cwd=${encodeURIComponent(cwd)}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(700) });
  if (response.ok) {
    const text = await response.text();
    if (text) process.stdout.write(text);
  }
} catch {
  // Fail open and silent: no context is safer than delaying Agent startup.
}
