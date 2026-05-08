/** V2 Context builder — topic-first progressive disclosure for agentSpawn injection. */

import { MemoryDB, type Memory, type Topic } from './db';
import type { Config, Language } from './config';

const MAX_BYTES = 9500; // leave margin below 10240

export function buildContext(
  db: MemoryDB,
  cwd: string,
  ctx: Config['context'],
  language: Language = 'zh',
): string {
  const repo = detectRepoSync(cwd);
  const budget = Math.min(ctx.maxOutputBytes || 8192, MAX_BYTES);

  const parts: string[] = ['<kiro-mem-context>'];
  let used = 20; // opening tag

  // --- Pinned Memories ---
  if (ctx.includePinned) {
    const pinned = db.getPinnedMemories(10);
    if (pinned.length) {
      const section = renderPinned(pinned);
      if (used + section.length < budget) {
        parts.push(section);
        used += section.length;
      }
    }
  }

  // --- Active Topics ---
  const topics = db.getActiveTopics(repo, 8);
  if (topics.length) {
    const section = renderTopics(topics);
    if (used + section.length < budget) {
      parts.push(section);
      used += section.length;
    }
  }

  // --- Recent Memories ---
  const recent = db.searchMemoriesFts('', {
    repo: repo || undefined,
    cwd: !repo && cwd ? cwd : undefined,
    days: 30,
    limit: ctx.maxMemories || 30,
  });
  // Exclude pinned (already shown above)
  const pinnedIds = new Set(db.getPinnedMemories(10).map(m => m.id));
  const recentFiltered = recent.filter(m => !pinnedIds.has(m.id));

  if (recentFiltered.length) {
    const section = renderRecent(recentFiltered, budget - used - 200);
    if (section) {
      parts.push(section);
      used += section.length;
    }
  }

  // --- How To Use ---
  const howTo = language === 'en'
    ? '\n---\n💡 Use @kiro-mem/search to search memories | @kiro-mem/get_memories for details | @kiro-mem/trace_memory to trace sources | @kiro-mem/topics to browse topics'
    : '\n---\n💡 使用 @kiro-mem/search 搜索记忆 | @kiro-mem/get_memories 获取详情 | @kiro-mem/trace_memory 追溯来源 | @kiro-mem/topics 浏览主题';
  if (used + howTo.length + 25 < budget) {
    parts.push(howTo);
  }

  parts.push('</kiro-mem-context>');

  const result = parts.join('\n');
  return result || '';
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

function renderRecent(memories: Memory[], maxBytes: number): string | null {
  const lines = ['', '## Recent Memories'];
  let size = 20;
  for (const m of memories) {
    const line = `- #M${m.id} [${m.memory_type}] ${m.title} (${m.last_turn_at?.slice(0, 10) || ''})`;
    if (size + line.length + 1 > maxBytes) break;
    lines.push(line);
    size += line.length + 1;
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
