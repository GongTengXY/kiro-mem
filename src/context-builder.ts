import { MemoryDB, type Observation } from './db';
import type { Config } from './config';

const TYPE_EMOJI: Record<string, string> = {
  decision: '🟤',
  bugfix: '🟡',
  feature: '🟢',
  refactor: '🔵',
  discovery: '🟣',
  change: '⚪',
};

export function buildContext(
  db: MemoryDB,
  cwd: string,
  ctx: Config['context'],
): string {
  const repo = detectRepoSync(cwd);

  const pinned = ctx.includePinned ? db.getPinnedObservations(10) : [];
  const recent = db.getRecentObservations(
    cwd || null,
    repo,
    ctx.maxSessions,
    ctx.maxObservations,
  );
  const pinnedIds = new Set(pinned.map((o) => o.id));
  const observations = recent.filter((o) => !pinnedIds.has(o.id));

  let lastSummary: string | null = null;
  if (ctx.includeSummary) {
    const sessions = db.getRecentSessions(cwd || null, repo, 1);
    if (sessions.length) {
      const s = sessions[0]!;
      lastSummary = [s.summary_request, s.summary_completed]
        .filter(Boolean)
        .join(' → ');
    }
  }

  if (!observations.length && !pinned.length && !lastSummary) return '';

  const parts: string[] = ['<kiro-mem-context>'];

  // 上次 session summary（可选）
  if (lastSummary) {
    parts.push(`> 上次会话: ${lastSummary}`, '');
  }

  // Pinned 置顶
  if (pinned.length) {
    parts.push('## 📌 重要记忆');
    parts.push('| ID | T | 标题 | ~Tokens |');
    parts.push('|----|---|------|---------|');
    for (const o of pinned) {
      parts.push(indexRow(o));
    }
    parts.push('');
  }

  // 最近记忆
  if (observations.length) {
    parts.push('## 最近记忆');

    // 展开全文的前 N 条
    const fullObs = observations.slice(0, ctx.fullCount);
    for (const o of fullObs) {
      const emoji = TYPE_EMOJI[o.obs_type || ''] || '⚪';
      const tokens = tokensOf(o);
      parts.push(
        `**#${o.id}** ${emoji} ${o.title || ''} (${fmtTime(o.created_at)}, ~${tokens} tokens)`,
      );
      const detail =
        ctx.fullField === 'facts' && o.facts
          ? JSON.parse(o.facts).join('; ')
          : o.narrative || '';
      if (detail) parts.push(detail);
      parts.push('');
    }

    // 剩余按文件路径分组的索引表
    const rest = observations.slice(ctx.fullCount);
    if (rest.length) {
      for (const [file, obs] of groupByFile(rest)) {
        parts.push(`**${file}**`);
        parts.push('| ID | 时间 | T | 标题 | ~Tokens |');
        parts.push('|----|------|---|------|---------|');
        for (const o of obs) {
          const emoji = TYPE_EMOJI[o.obs_type || ''] || '⚪';
          const tokens = tokensOf(o);
          parts.push(
            `| #${o.id} | ${fmtTime(o.created_at)} | ${emoji} | ${o.title || ''} | ~${tokens} |`,
          );
        }
        parts.push('');
        if (estimateBytes(parts) > ctx.maxOutputBytes * 0.9) break;
      }
    }
  }

  // 图例 + 使用提示
  parts.push('---');
  parts.push('🟤决策 🟡修复 🟢功能 🔵重构 🟣发现 ⚪变更');
  parts.push('');
  parts.push('💡 **渐进式披露:** 以上索引展示了记忆概览和检索成本。');
  parts.push('- 使用 @kiro-mem/get_observations 按 ID 获取完整详情');
  parts.push('- 使用 @kiro-mem/timeline 查看某条记忆前后的上下文');
  parts.push('- 使用 @kiro-mem/search 搜索更多历史记忆');
  parts.push('- 🟤决策 和 📌pinned 类型通常值得立即获取');
  parts.push('</kiro-mem-context>');

  const result = parts.join('\n');
  return result.length > ctx.maxOutputBytes
    ? result.slice(0, ctx.maxOutputBytes)
    : result;
}

// --- Helpers ---

function indexRow(o: Observation): string {
  const emoji = TYPE_EMOJI[o.obs_type || ''] || '⚪';
  return `| #${o.id} | ${emoji} | ${o.title || ''} | ~${tokensOf(o)} |`;
}

function groupByFile(observations: Observation[]): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const files: string[] = o.files ? JSON.parse(o.files) : [];
    const key = files[0] || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }
  return groups;
}

function tokensOf(o: Observation): number {
  if (o.compressed_tokens) return o.compressed_tokens;
  const len = (o.narrative || '').length + (o.facts || '').length;
  return Math.max(Math.round(len / 2), 20);
}

function estimateBytes(parts: string[]): number {
  return parts.reduce((sum, p) => sum + p.length + 1, 0);
}

function fmtTime(isoStr: string | null): string {
  if (!isoStr) return '';
  const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function detectRepoSync(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd,
    });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {}
  return null;
}
