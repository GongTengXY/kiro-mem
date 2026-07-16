/**
 * AgentSpawn bootstrap index (design §7.3).
 *
 * Injects a COMPACT MENU of atomic Observations for the current workspace
 * scope — not content. It is progressive-disclosure: the agent scans this
 * index, then pulls detail on demand via the MCP search / timeline /
 * get_observations tools.
 *
 * Hard constraints:
 *   - Hard-scoped by computeScopeKey(repo, cwd); never crosses workspaces.
 *   - Reads only already-indexed Observations. No ACP, no embedding, no
 *     waiting on the current turn's compression.
 *   - NO LLM synthesis, NO topics/aggregation, NO cross-scope data, NO long
 *     summaries or full evidence.
 *   - Stays within the UTF-8 byte budget.
 *   - Empty scope => usage note only (or effectively empty).
 */

import { MemoryDB, computeScopeKey, type Observation } from './db';
import type { Config, Language } from './config';

const MAX_BYTES = 9500; // margin below the agentSpawn 10KB limit
const CLOSING_TAG = '</kiro-mem-context>';

// Configurable defaults (design §7.3). Kept as module constants for Phase 3;
// Phase 4 can surface them through config if needed.
const PINNED_LIMIT = 5;
const DETAIL_LIMIT = 5;
const INDEX_LIMIT = 50;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function buildBootstrapContext(
  db: MemoryDB,
  cwd: string,
  ctx: Config['context'],
  language: Language = 'zh',
): string {
  const repo = detectRepoSync(cwd);
  const scopeKey = computeScopeKey(repo, cwd || null);
  const budget = Math.min(ctx.maxOutputBytes || 8192, MAX_BYTES);

  const parts: string[] = ['<kiro-mem-context>'];
  let used = byteLen(parts[0]!);

  // --- 1. Minimal usage note (always first, cheap) ---
  const usage =
    language === 'en'
      ? '\n💡 Prior work in this workspace is listed below as an index (#O{id}). Pull detail on demand: @kiro-mem/search to find, @kiro-mem/timeline to see surrounding work, @kiro-mem/get_observations for full detail.'
      : '\n💡 下面是本 workspace 的历史工作索引（#O{id}），按需展开：@kiro-mem/search 查找 | @kiro-mem/timeline 看前后工作 | @kiro-mem/get_observations 取完整详情。';
  if (used + byteLen(usage) + byteLen(CLOSING_TAG) + 2 < budget) {
    parts.push(usage);
    used += byteLen(usage) + 1;
  }

  // --- 2. Pinned (hard-scoped, up to PINNED_LIMIT) ---
  const pinned = db.getPinnedObservations({ scopeKey, limit: PINNED_LIMIT });
  const pinnedIds = new Set(pinned.map((o) => o.id));
  if (pinned.length) {
    const section = renderPinned(pinned, language);
    const bytes = byteLen(section) + 1;
    if (used + bytes + byteLen(CLOSING_TAG) < budget) {
      parts.push(section);
      used += bytes;
    }
  }

  // --- Recent set (detail + index), excluding pinned ---
  const recent = db
    .getRecentObservations({ scopeKey, limit: DETAIL_LIMIT + INDEX_LIMIT + pinned.length })
    .filter((o) => !pinnedIds.has(o.id));
  const detail = recent.slice(0, DETAIL_LIMIT);
  const index = recent.slice(DETAIL_LIMIT, DETAIL_LIMIT + INDEX_LIMIT);

  // --- 3. Recent details (title + short outcome/next_steps snippet) ---
  if (detail.length) {
    const section = renderDetail(detail, language);
    const bytes = byteLen(section) + 1;
    if (used + bytes + byteLen(CLOSING_TAG) < budget) {
      parts.push(section);
      used += bytes;
    }
  }

  // --- 4. Recent index (compact one-liners with read-cost estimate) ---
  if (index.length) {
    const section = renderIndex(index, budget - used - byteLen(CLOSING_TAG) - 2, language);
    if (section) {
      parts.push(section);
      used += byteLen(section) + 1;
    }
  }

  parts.push(CLOSING_TAG);

  const result = parts.join('\n');
  if (byteLen(result) <= budget) return result;

  // Safety net: drop optional sections from the end until we fit.
  while (parts.length > 2 && byteLen(parts.join('\n')) > budget) {
    parts.splice(parts.length - 2, 1);
  }
  const minimal = parts.join('\n');
  if (byteLen(minimal) <= budget) return minimal;
  return `<kiro-mem-context>\n${CLOSING_TAG}`;
}

// --- Renderers ---

function renderPinned(observations: Observation[], language: Language): string {
  const header = language === 'en' ? '## 📌 Pinned' : '## 📌 置顶';
  const lines = ['', header];
  for (const o of observations) {
    const next = o.next_steps?.trim() ? ` → _${clip(o.next_steps, 60)}_` : '';
    lines.push(`- **#O${o.id}** ${clip(o.title, 80)}${next}`);
  }
  return lines.join('\n');
}

function renderDetail(observations: Observation[], language: Language): string {
  const header = language === 'en' ? '## Recent (detail)' : '## 最近（详情）';
  const lines = ['', header];
  for (const o of observations) {
    lines.push(`- #O${o.id} [${o.memory_type}] ${clip(o.title, 80)} (${date(o)})`);
    // A single short snippet: prefer outcome, else next_steps, else summary.
    const snippet = firstNonEmpty(o.outcome, o.next_steps, o.summary);
    if (snippet) lines.push(`  ${clip(snippet, 120)}`);
  }
  return lines.join('\n');
}

function renderIndex(observations: Observation[], maxBytes: number, language: Language): string | null {
  const header = language === 'en' ? '## Recent (index)' : '## 最近（索引）';
  const lines = ['', header];
  let size = byteLen(header) + 2;
  for (const o of observations) {
    const line = `- #O${o.id}  ${date(o)}  [${o.memory_type}]  ${clip(o.title, 70)}  (~${fetchCostTokens(o)}t)`;
    const bytes = byteLen(line) + 1;
    if (size + bytes > maxBytes) break;
    lines.push(line);
    size += bytes;
  }
  if (lines.length <= 2) return null;
  return lines.join('\n');
}

// --- Helpers ---

/**
 * Approximate token cost to fetch this Observation's full detail via
 * get_observations. Read-time estimate (~4 bytes/token), never persisted —
 * gives the agent token-cost visibility before pulling.
 */
function fetchCostTokens(o: Observation): number {
  const bytes =
    byteLen(o.summary || '') +
    byteLen(o.request || '') +
    byteLen(o.outcome || '') +
    byteLen(o.learned || '') +
    byteLen(o.next_steps || '') +
    byteLen(o.evidence_json || '') +
    byteLen(o.concepts_json || '') +
    byteLen(o.files_touched_json || '');
  return Math.max(1, Math.round(bytes / 4));
}

function date(o: Observation): string {
  return o.turn_stopped_at?.slice(0, 10) || '';
}

function firstNonEmpty(...vals: (string | null)[]): string {
  for (const v of vals) {
    if (v && v.trim()) return v;
  }
  return '';
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function detectRepoSync(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {}
  return null;
}
