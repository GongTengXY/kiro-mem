import { MemoryDB, type Session, type Observation } from './db';

export function buildContext(
  db: MemoryDB,
  cwd: string,
  maxSessions: number,
  maxBytes: number,
  includePinned: boolean,
): string {
  const repo = detectRepoSync(cwd);
  const sessions = db.getRecentSessions(cwd || null, repo, maxSessions);
  const pinned = includePinned ? db.getPinnedObservations(10) : [];

  if (!sessions.length && !pinned.length) return '';

  const parts: string[] = ['<kiro-memory-context>', '## 最近会话记忆', ''];

  for (const s of sessions) {
    const date = formatLocalTime(s.started_at);
    parts.push(`### ${date} - ${s.cwd}`);
    if (s.summary_request) parts.push(`请求: ${s.summary_request}`);
    if (s.summary_completed) parts.push(`完成: ${s.summary_completed}`);
    if (s.summary_learned) parts.push(`关键发现: ${s.summary_learned}`);
    if (s.summary_next_steps) parts.push(`后续: ${s.summary_next_steps}`);
    parts.push('');

    // 检查大小
    if (estimateBytes(parts) > maxBytes * 0.9) break;
  }

  if (pinned.length) {
    parts.push('## 重要记忆 (pinned)', '');
    for (const obs of pinned) {
      if (estimateBytes(parts) > maxBytes * 0.95) break;
      parts.push(`- **${obs.title}**: ${obs.narrative || ''}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('提示: 如需搜索更多历史记忆，使用 @kiro-memory/search 工具。');
  parts.push('</kiro-memory-context>');

  const result = parts.join('\n');
  // 硬截断保护
  if (result.length > maxBytes) return result.slice(0, maxBytes);
  return result;
}

function estimateBytes(parts: string[]): number {
  return parts.reduce((sum, p) => sum + p.length + 1, 0);
}

function formatLocalTime(isoStr: string | null): string {
  if (!isoStr) return 'unknown';
  const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
