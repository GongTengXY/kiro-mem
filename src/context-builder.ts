/** V2 Context builder — topic-first progressive disclosure for agentSpawn injection. */

import { MemoryDB, type Memory, type Topic } from './db';
import type { Config, Language } from './config';

const MAX_BYTES = 9500; // leave margin below 10240
const CLOSING_TAG = '</kiro-mem-context>';

/** UTF-8 byte length helper — the real cost unit for agentSpawn budget. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function buildContext(
  db: MemoryDB,
  cwd: string,
  ctx: Config['context'],
  language: Language = 'zh',
): string {
  const repo = detectRepoSync(cwd);
  const budget = Math.min(ctx.maxOutputBytes || 8192, MAX_BYTES);

  const parts: string[] = ['<kiro-mem-context>'];
  let used = byteLen(parts[0]!);

  // --- Pinned Memories ---
  // Fetched once and reused as the exclusion set for recent memories below.
  const pinned = ctx.includePinned ? db.getPinnedMemories(10) : [];
  if (pinned.length) {
    const section = renderPinned(pinned);
    const sectionBytes = byteLen(section) + 1; // +1 for join '\n'
    if (used + sectionBytes < budget) {
      parts.push(section);
      used += sectionBytes;
    }
  }

  // --- Active Topics ---
  // Use scope-aware lookup so non-git workspaces get their own topic
  // namespace (computeScopeKey(repo, cwd)) instead of seeing all NULL-repo
  // topics from every unrelated non-git session in the world.
  const topics = db.getActiveTopics({ repo, cwd: cwd || null, limit: 8 });
  if (topics.length) {
    const section = renderTopics(topics);
    const sectionBytes = byteLen(section) + 1;
    if (used + sectionBytes < budget) {
      parts.push(section);
      used += sectionBytes;
    }
  }

  // --- Recent Memories ---
  // `includeSummary` turns every memory line into a two-line entry (title +
  // indented summary snippet). Each entry therefore costs ~3x bytes, so we
  // auto-cap the list at ~20 to keep injection inside budget. Users who
  // really want more can raise maxMemories explicitly, but the
  // auto-tightening is the safe default.
  const recentLimit = ctx.includeSummary
    ? Math.min(ctx.maxMemories || 30, 20)
    : (ctx.maxMemories || 30);
  const recent = db.searchMemoriesFts('', {
    repo: repo || undefined,
    cwd: !repo && cwd ? cwd : undefined,
    days: 30,
    limit: recentLimit,
  });
  // Exclude pinned (already shown above)
  const pinnedIds = new Set(pinned.map(m => m.id));
  const recentFiltered = recent.filter(m => !pinnedIds.has(m.id));

  if (recentFiltered.length) {
    const section = renderRecent(recentFiltered, budget - used - 200, ctx.includeSummary);
    if (section) {
      parts.push(section);
      used += byteLen(section) + 1;
    }
  }

  // --- How To Use ---
  const howTo = language === 'en'
    ? '\n---\n💡 Use @kiro-mem/search to search memories | @kiro-mem/get_memories for details | @kiro-mem/trace_memory to trace sources | @kiro-mem/topics to browse topics'
    : '\n---\n💡 使用 @kiro-mem/search 搜索记忆 | @kiro-mem/get_memories 获取详情 | @kiro-mem/trace_memory 追溯来源 | @kiro-mem/topics 浏览主题';
  if (used + byteLen(howTo) + byteLen(CLOSING_TAG) + 2 < budget) {
    parts.push(howTo);
  }

  parts.push(CLOSING_TAG);

  const result = parts.join('\n');
  if (byteLen(result) <= budget) return result;

  // Last-ditch safety net: drop optional sections from the end while keeping
  // the XML wrapper valid. This should only trigger on pathological pinned /
  // topic text because normal section admission already budgets by UTF-8 bytes.
  while (parts.length > 2 && byteLen(parts.join('\n')) > budget) {
    parts.splice(parts.length - 2, 1);
  }
  const minimal = parts.join('\n');
  if (byteLen(minimal) <= budget) return minimal;

  return `<kiro-mem-context>\n${CLOSING_TAG}`;
}

// --- Renderers ---

function renderPinned(memories: Memory[]): string {
  const lines = ['', '## 📌 Pinned Memories'];
  for (const m of memories) {
    lines.push(`- **#M${m.id}** ${m.title}${m.next_steps ? ` → _${m.next_steps.slice(0, 60)}_` : ''}`);
  }
  return lines.join('\n');
}

function renderTopics(topics: Topic[]): string {
  const lines = ['', '## Active Topics'];
  for (const t of topics) {
    const unresolved = t.unresolved_summary ? ` — ${t.unresolved_summary.slice(0, 80)}` : '';
    lines.push(`- **${t.canonical_label}** (${t.memory_count} memories)${unresolved}`);
  }
  return lines.join('\n');
}

function renderRecent(
  memories: Memory[],
  maxBytes: number,
  includeSummary: boolean = false,
): string | null {
  const lines = ['', '## Recent Memories'];
  let size = byteLen('## Recent Memories') + 2; // header + two newlines
  for (const m of memories) {
    const line = `- #M${m.id} [${m.memory_type}] ${m.title} (${m.last_turn_at?.slice(0, 10) || ''})`;
    const lineBytes = byteLen(line) + 1;
    if (size + lineBytes > maxBytes) break;
    lines.push(line);
    size += lineBytes;

    // Opt-in second line: indented summary snippet. Keep the snippet small
    // (160 chars) — longer summaries rapidly chew through the 8-10KB budget
    // that agentSpawn gives us. If the budget can't fit this line we just
    // skip it rather than aborting the whole section.
    if (includeSummary && m.summary) {
      const snippet = m.summary.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (snippet) {
        const summaryLine = `  ${snippet}`;
        const summaryBytes = byteLen(summaryLine) + 1;
        if (size + summaryBytes <= maxBytes) {
          lines.push(summaryLine);
          size += summaryBytes;
        }
      }
    }
  }
  if (lines.length <= 2) return null; // only header, no items
  return lines.join('\n');
}

// --- Helpers ---

function detectRepoSync(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {}
  return null;
}
