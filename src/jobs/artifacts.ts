/** Deterministic artifact extraction from turn_events (no LLM). */

import type { MemoryDB } from '../db';

export interface ExtractedArtifacts {
  tool_names: string[];
  files_touched: string[];
  /** Shell commands, enriched with a truncated `(exit N)` suffix when known. */
  commands: string[];
  error_signals: string[];
  /**
   * Test / build / lint outcomes distilled from commands + responses, e.g.
   * "test PASS: 119 pass, 0 fail" or "build FAIL (exit 1)". The summarize_turn job
   * uses these as high-priority evidence. Computed live from turn_events; not
   * persisted to the turn_artifacts cache.
   */
  test_signals: string[];
  /**
   * VCS / dependency state-change commands (git commit/merge/checkout, package
   * installs) that did not explicitly fail. Truth-layer signal that a
   * project-state decision was committed. Persisted to turn_artifacts; NOT part
   * of the ACP summarize input contract (§6.4).
   */
  decision_signals: string[];
  /**
   * High-confidence, tool-verifiable fact fragments (§6.2). Currently: file
   * mutation semantics — "created|modified|deleted <path>" distilled from
   * write-family tool calls. This is distinct from files_touched, which also
   * collects paths that were merely read. Fed to the compressor as evidence.
   */
  facts: string[];
  stats: { event_count: number; total_payload_bytes: number };
}

export function extractArtifacts(db: MemoryDB, turnId: number): ExtractedArtifacts {
  const events = db.listTurnEvents(turnId);

  const toolNames = new Set<string>();
  const files = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  const testSignals: string[] = [];
  const decisions: string[] = [];
  const facts: string[] = [];
  let totalBytes = 0;

  for (const ev of events) {
    totalBytes += ev.payload_size;
    if (ev.tool_name) toolNames.add(ev.tool_name);

    if (ev.hook_event_name === 'postToolUse') {
      const payload = safeParse(ev.payload_json);
      extractFromToolEvent(payload, ev.tool_name, files, commands, errors, testSignals, decisions, facts);
    }
  }

  const result: ExtractedArtifacts = {
    tool_names: [...toolNames],
    files_touched: [...files].slice(0, 50),
    commands: commands.slice(0, 20),
    error_signals: errors.slice(0, 10),
    test_signals: dedupe(testSignals).slice(0, 10),
    decision_signals: dedupe(decisions).slice(0, 10),
    facts: dedupe(facts).slice(0, 20),
    stats: { event_count: events.length, total_payload_bytes: totalBytes },
  };

  // Persist the cached subset to turn_artifacts (the deterministic cache).
  // test_signals is intentionally NOT persisted here — it is derived live from
  // turn_events, so the shared Truth-layer table keeps its stable schema.
  db.upsertTurnArtifacts(turnId, {
    tool_names_json: JSON.stringify(result.tool_names),
    files_touched_json: JSON.stringify(result.files_touched),
    commands_json: JSON.stringify(result.commands),
    error_signals_json: JSON.stringify(result.error_signals),
    decision_signals_json: JSON.stringify(result.decision_signals),
    facts_json: JSON.stringify(result.facts),
    stats_json: JSON.stringify(result.stats),
  });

  return result;
}

// --- Internal helpers ---

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json); } catch { return {}; }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

const SHELL_TOOLS = new Set(['shell', 'bash', 'execute_bash', 'executeBash']);

function extractFromToolEvent(
  payload: Record<string, unknown>,
  toolName: string | null,
  files: Set<string>,
  commands: string[],
  errors: string[],
  testSignals: string[],
  decisions: string[],
  facts: string[],
) {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const response = payload.tool_response as unknown;

  // Error signal from the response (prefer stderr). Computed up front so a file
  // mutation fact can be gated on the tool call NOT having failed.
  const errText = extractErrorText(response);

  // File paths from common tool patterns
  if (input) {
    const path = (input.path || input.file_path || input.filePath) as string | undefined;
    if (path && typeof path === 'string') files.add(path);

    // glob/pattern results
    const paths = input.paths as string[] | undefined;
    if (Array.isArray(paths)) paths.forEach(p => { if (typeof p === 'string') files.add(p); });

    // High-confidence fact: a file was actually mutated (create/edit/delete),
    // as opposed to merely read. files_touched can't express this because it
    // also collects read paths.
    const mutation = detectFileMutation(toolName, input, !!errText);
    if (mutation) facts.push(mutation);

    // shell commands
    const cmd = input.command as string | undefined;
    if (cmd && typeof cmd === 'string' && (toolName != null && SHELL_TOOLS.has(toolName))) {
      const exit = extractExitStatus(response);
      const base = cmd.replace(/\s+/g, ' ').trim().slice(0, 180);
      commands.push(exit != null ? `${base} (exit ${exit})` : base);

      // Test / build / lint signal detection.
      const sig = detectBuildKind(cmd);
      if (sig) {
        const verdict = classifyOutcome(exit, response);
        const detail = extractTestCounts(response);
        testSignals.push(
          `${sig} ${verdict}${detail ? `: ${detail}` : exit != null ? ` (exit ${exit})` : ''}`,
        );
      }

      // Decision signal: a VCS / dependency state change was committed.
      const decision = detectDecisionSignal(cmd, exit);
      if (decision) decisions.push(decision);
    }
  }

  if (errText) errors.push(errText.slice(0, 200));
}

// Write-family classification for file-mutation facts.
const WRITE_COMMAND_VERBS: Record<string, string> = {
  create: 'created',
  strreplace: 'modified',
  str_replace: 'modified',
  insert: 'modified',
  append: 'modified',
};
const DELETE_TOOL_RE = /delete|remove|unlink|\brm\b/i;
const WRITE_TOOL_RE = /write|create|edit|replace/i;

/**
 * Map a write-family tool call to a "<verb> <path>" fact, or null. Detection
 * keys primarily off the write tool's `command` (create/strReplace/insert),
 * then falls back to the tool name for command-less write/delete tools. A
 * failed call (`hadError`) never yields a mutation fact — we don't claim a file
 * was changed when the tool reported an error.
 */
function detectFileMutation(
  toolName: string | null,
  input: Record<string, unknown>,
  hadError: boolean,
): string | null {
  if (hadError) return null;
  const path = (input.path || input.file_path || input.filePath) as string | undefined;
  if (!path || typeof path !== 'string') return null;

  const cmd = typeof input.command === 'string' ? input.command.toLowerCase() : '';
  let verb: string | undefined = WRITE_COMMAND_VERBS[cmd];
  if (!verb && toolName) {
    if (DELETE_TOOL_RE.test(toolName)) verb = 'deleted';
    else if (WRITE_TOOL_RE.test(toolName)) verb = 'wrote';
  }
  if (!verb) return null;
  return `${verb} ${path}`;
}

// VCS / dependency state-change command patterns.
const VCS_RE = /\bgit\s+(commit|merge|rebase|checkout|switch|reset|revert|cherry-pick|tag|push|pull|stash|branch\s+-)/;
const DEP_RE = /\b(npm|yarn|pnpm|bun)\s+(install|add|remove|uninstall|i)\b|\b(pip|pip3)\s+(install|uninstall)\b|\bcargo\s+(add|remove)\b|\bgo\s+(get|mod)\b/;

/**
 * Detect a VCS / dependency state-change command. Only records commands that
 * did not explicitly fail (exit 0 or unknown) — a failed state change is not a
 * committed decision.
 */
function detectDecisionSignal(cmd: string, exit: number | null): string | null {
  if (exit != null && exit !== 0) return null;
  const c = cmd.toLowerCase();
  if (!VCS_RE.test(c) && !DEP_RE.test(c)) return null;
  return cmd.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Best-effort exit-status extraction. Handles object responses with common
 * key names and string responses like "exit status: 1" / "exit code 1".
 */
function extractExitStatus(response: unknown): number | null {
  if (response == null) return null;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    for (const key of ['exit_status', 'exitStatus', 'exit_code', 'exitCode', 'code', 'status']) {
      const v = r[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const m = v.match(/-?\d+/);
        if (m) return Number(m[0]);
      }
    }
    return null;
  }
  if (typeof response === 'string') {
    const m = response.match(/exit(?:\s+status|\s+code)?[:\s]+(-?\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Returns 'test' | 'build' | 'lint' if the command looks like one, else null. */
function detectBuildKind(cmd: string): 'test' | 'build' | 'lint' | null {
  const c = cmd.toLowerCase();
  if (/\b(eslint|prettier|ruff|flake8|clippy|golangci-lint|\blint\b)/.test(c)) return 'lint';
  if (/\b(jest|vitest|pytest|mocha|phpunit|rspec)\b/.test(c) || /\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/.test(c) || /\b(go|cargo)\s+test\b/.test(c) || /\btest\b/.test(c)) return 'test';
  if (/\b(tsc|webpack|rollup|esbuild|make|mvn|gradle)\b/.test(c) || /\b(vite|next|nest|npm|yarn|pnpm|bun)\s+(run\s+)?build\b/.test(c) || /\b(go|cargo)\s+build\b/.test(c) || /\bbuild\b/.test(c)) return 'build';
  return null;
}

/** PASS / FAIL / RAN based on exit code (preferred) then textual signals. */
function classifyOutcome(exit: number | null, response: unknown): 'PASS' | 'FAIL' | 'RAN' {
  if (exit != null) return exit === 0 ? 'PASS' : 'FAIL';
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  if (/\b(\d+)\s+fail(ed|ures)?\b/i.test(text)) {
    const m = text.match(/\b(\d+)\s+fail(ed|ures)?\b/i);
    if (m && Number(m[1]) > 0) return 'FAIL';
  }
  if (/\b(fail|error|✗|✖)\b/i.test(text)) return 'FAIL';
  if (/\b(pass|passed|✓|ok|success)\b/i.test(text)) return 'PASS';
  return 'RAN';
}

/** Pull a compact "N pass, M fail" style detail out of a test/build response. */
function extractTestCounts(response: unknown): string | null {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  const pass = text.match(/(\d+)\s+pass(?:ed|ing)?/i);
  const fail = text.match(/(\d+)\s+fail(?:ed|ures|ing)?/i);
  const parts: string[] = [];
  if (pass) parts.push(`${pass[1]} pass`);
  if (fail) parts.push(`${fail[1]} fail`);
  return parts.length ? parts.join(', ') : null;
}

/** Extract a meaningful error string from a tool response, preferring stderr. */
function extractErrorText(response: unknown): string | null {
  if (typeof response === 'string') {
    if (/\b(error|fail)/i.test(response)) return response;
    return null;
  }
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    const stderr = r.stderr;
    if (typeof stderr === 'string' && stderr.trim() && /\b(error|fail)/i.test(stderr)) {
      return stderr;
    }
    const resStr = JSON.stringify(response).slice(0, 500);
    if (/\b(error|fail)/i.test(resStr)) return resStr;
  }
  return null;
}
