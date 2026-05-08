/** Deterministic artifact extraction from turn_events (no LLM). */

import type { MemoryDB } from '../db';

export interface ExtractedArtifacts {
  tool_names: string[];
  files_touched: string[];
  commands: string[];
  error_signals: string[];
  decision_signals: string[];
  facts: string[];
  stats: { event_count: number; total_payload_bytes: number };
}

export function extractArtifacts(db: MemoryDB, turnId: number): ExtractedArtifacts {
  const events = db.listTurnEvents(turnId);

  const toolNames = new Set<string>();
  const files = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  const decisions: string[] = [];
  const facts: string[] = [];
  let totalBytes = 0;

  for (const ev of events) {
    totalBytes += ev.payload_size;
    if (ev.tool_name) toolNames.add(ev.tool_name);

    if (ev.hook_event_name === 'postToolUse') {
      const payload = safeParse(ev.payload_json);
      extractFromToolEvent(payload, ev.tool_name, files, commands, errors, decisions, facts);
    }
  }

  const result: ExtractedArtifacts = {
    tool_names: [...toolNames],
    files_touched: [...files].slice(0, 50),
    commands: commands.slice(0, 20),
    error_signals: errors.slice(0, 10),
    decision_signals: decisions.slice(0, 10),
    facts: facts.slice(0, 20),
    stats: { event_count: events.length, total_payload_bytes: totalBytes },
  };

  // Persist to turn_artifacts
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

function extractFromToolEvent(
  payload: Record<string, unknown>,
  toolName: string | null,
  files: Set<string>,
  commands: string[],
  errors: string[],
  decisions: string[],
  facts: string[],
) {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const response = payload.tool_response as unknown;

  // File paths from common tool patterns
  if (input) {
    const path = (input.path || input.file_path || input.filePath) as string | undefined;
    if (path && typeof path === 'string') files.add(path);

    // glob/pattern results
    const paths = input.paths as string[] | undefined;
    if (Array.isArray(paths)) paths.forEach(p => { if (typeof p === 'string') files.add(p); });

    // shell commands
    const cmd = input.command as string | undefined;
    if (cmd && typeof cmd === 'string' && (toolName === 'shell' || toolName === 'bash')) {
      commands.push(cmd.slice(0, 200));
    }
  }

  // Error signals from response
  if (typeof response === 'string') {
    if (response.includes('Error') || response.includes('error') || response.includes('FAIL')) {
      errors.push(response.slice(0, 200));
    }
  } else if (response && typeof response === 'object') {
    const resStr = JSON.stringify(response).slice(0, 500);
    if (resStr.includes('error') || resStr.includes('Error')) {
      errors.push(resStr.slice(0, 200));
    }
  }
}
