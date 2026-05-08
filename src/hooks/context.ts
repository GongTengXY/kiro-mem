#!/usr/bin/env bun
/**
 * agentSpawn hook: fetch context from Worker, output to STDOUT for injection.
 * Tries to restart Worker via launchd/systemd if unreachable.
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
const event = JSON.parse(input);
const cwd = event.cwd || '';
const port = readPort();
const token = readToken();
const url = `http://127.0.0.1:${port}/context?cwd=${encodeURIComponent(cwd)}`;
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

let response: Response | null = null;
try {
  response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
} catch {
  // Try restart and retry once
  try {
    if (process.platform === 'darwin') {
      Bun.spawnSync(['launchctl', 'load', `${HOME}/Library/LaunchAgents/com.kiro-mem.worker.plist`]);
    } else {
      Bun.spawnSync(['systemctl', '--user', 'start', 'kiro-mem.service']);
    }
    await Bun.sleep(1000);
    response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  } catch { process.exit(0); }
}

if (response?.ok) {
  const text = await response.text();
  if (text) process.stdout.write(text);
}
