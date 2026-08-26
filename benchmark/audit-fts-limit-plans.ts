/**
 * `LIMIT ?` 缺陷审计：src/db/index.ts 全部 12 处的查询计划与耗时。
 *
 * 判据：`benchmark/reports/fix-fts-limit-criteria.md`（A0，冻结于本脚本第一次运行之前）。
 * 裁决第 3 条要求「审计其余 11 处，但不能机械批量改写；有翻转证据的才处理」。
 *
 * 转写风险与它的挡法：本脚本必须把生产动态拼出来的 SQL 抄一份进来才能 EXPLAIN，而抄错就会
 * 审计到一条生产从不执行的语句。所以每一处都带一个 `verify`：跑生产方法、跑转写的 SQL，
 * 断言两者返回的行 id 逐条相同。对不上就直接退出，不产出报告——一份"审计过了"的报告如果
 * 审的是别的 SQL，比没有审计更糟。
 *
 * 规模语料复用 3B 冻结的装置：换语料就无法与 3B 的读数对照。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const DATASET_DIR = join(import.meta.dir, 'dataset');
const REPORTS_DIR = join(import.meta.dir, 'reports');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

let tmpDir: string | null = null;
const die = (msg: string, err?: unknown): never => {
  console.error(`[audit] ✗ ${msg}`);
  if (err) console.error(err);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
};

// --- 3B 冻结装置 ---
const metaRaw = readFileSync(join(DATASET_DIR, 'phase3b-fixture-meta.json'), 'utf-8');
const meta = JSON.parse(metaRaw) as { frozen?: boolean; recallScale?: { filler?: { sha256?: string } } };
const fillerRaw = readFileSync(join(DATASET_DIR, 'phase3b-filler.json'), 'utf-8');
if (!meta.frozen) die('3B 装置未冻结');
if (sha16(fillerRaw) !== meta.recallScale?.filler?.sha256) {
  die(`填充语料 checksum 不匹配：${sha16(fillerRaw)} vs ${meta.recallScale?.filler?.sha256}`);
}
interface Filler {
  title: string; summary: string; outcome: string; learned: string;
  concepts: string[]; files: string[];
}
const filler = JSON.parse(fillerRaw) as Filler[];

const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');
const { Database } = await import('bun:sqlite');

tmpDir = mkdtempSync(join(tmpdir(), 'kiro-audit-'));
const dbPath = join(tmpDir, 'audit.db');
const db = new MemoryDB(dbPath);

// --- 播种：只需要行与文本，不需要向量（本轮审计的是 SQL 计划，与向量无关） ---
const CWD = '/proj/kiro-mem';
const SESSION = 's-audit';
db.upsertSessionRef({ session_id: SESSION, cwd: CWD, repo: CWD });
const BASE_MS = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 30 * 86400000;
})();
const obsIds: number[] = [];
for (const [i, f] of filler.entries()) {
  const seq = db.allocateNextTurnSeq(SESSION);
  const turn = db.createTurn({ session_id: SESSION, seq, cwd: CWD, repo: CWD, prompt_text: f.title });
  const ts = new Date(BASE_MS + i * 60_000).toISOString();
  db.markTurnClosed(turn.id, ts);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: SESSION, turn_seq: seq, repo: CWD, cwd_scope: CWD,
    title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
    memory_type: 'change', files_touched: f.files, concepts: f.concepts,
    quality: 'normal', turn_started_at: ts, turn_stopped_at: ts,
  });
  if (id == null) die(`播种失败 at ${i}`);
  obsIds.push(id!);
}
// 一条 pinned，否则 getPinnedObservations 的计划在空结果上没有意义。
db.pinObservation(obsIds[0]!, true);
console.log(`[audit] 播种 ${obsIds.length} 条（复用 3B 冻结填充语料）`);

const SCOPE = computeScopeKey(CWD, CWD);
const DAYS_THRESHOLD = new Date(Date.now() - 90 * 86400000).toISOString();
const raw = new Database(dbPath, { readonly: true });

// ---------------------------------------------------------------------------
// 审计单元
// ---------------------------------------------------------------------------

interface Site {
  line: number;
  method: string;
  /** 带 `LIMIT ?` 的 SQL（转写自源码）。`__LIMIT__` 会被替换成字面量或 `?`。 */
  sql: string;
  /** 除 limit 之外的参数。 */
  params: (string | number)[];
  limit: number;
  /** 跑生产方法，返回行 id 序列。用于证明转写忠实。 */
  verify?: () => number[];
  /** 从转写 SQL 的行里取 id 的字段名。 */
  idField?: string;
}

const anchor = db.getObservation(obsIds[1000]!)!;

const sites: Site[] = [
  {
    line: 574, method: 'listTurnsBySession',
    sql: `SELECT * FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT __LIMIT__`,
    params: [SESSION], limit: 50,
    verify: () => db.listTurnsBySession(SESSION, 50).map((t) => t.id),
  },
  {
    line: 1071, method: 'findObservationsMissingSemanticText',
    sql: `SELECT o.id AS id FROM observations o
             LEFT JOIN observation_semantic_texts s
               ON s.observation_id = o.id AND s.protocol = ?
            WHERE o.quality = 'normal'
              AND (s.observation_id IS NULL OR s.status = 'pending')
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'renormalize_observation'
                   AND j.dedupe_key = 'renorm:obs:' || o.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY o.id ASC LIMIT __LIMIT__`,
    params: ['semantic-en-v1'], limit: 500,
    verify: () => db.findObservationsMissingSemanticText({ protocol: 'semantic-en-v1', limit: 500 }),
  },
  {
    line: 1135, method: 'searchObservationsFts（LIKE 兜底）',
    // 2 字 query 走不到 trigram 门槛，落 LIKE 分支。
    sql: `SELECT * FROM observations
        WHERE turn_stopped_at > ?
          AND (title LIKE ? OR summary LIKE ? OR request LIKE ? OR outcome LIKE ?
               OR learned LIKE ? OR next_steps LIKE ? OR concepts_json LIKE ?
               OR files_touched_json LIKE ? OR evidence_json LIKE ?)
          AND scope_key = ?
        ORDER BY turn_stopped_at DESC, id DESC LIMIT __LIMIT__`,
    params: [DAYS_THRESHOLD, ...Array(9).fill('%UI%'), SCOPE], limit: 50,
    verify: () => db.searchObservationsFts('UI', { scopeKey: SCOPE, days: 90, limit: 50 }).map((o) => o.id),
  },
  {
    line: 1160, method: 'searchObservationsFts（FTS MATCH 主路径）',
    sql: `SELECT o.* FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?
        AND o.scope_key = ?
      ORDER BY fts.rank LIMIT __LIMIT__`,
    params: [
      extractFtsSearchUnits('当前安装流程里 Worker 是不是在运行中就被替换了')
        .map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR '),
      DAYS_THRESHOLD, SCOPE,
    ],
    limit: 50,
    verify: () =>
      db.searchObservationsFts('当前安装流程里 Worker 是不是在运行中就被替换了', {
        scopeKey: SCOPE, days: 90, limit: 50,
      }).map((o) => o.id),
  },
  {
    line: 1324, method: 'getRecentObservationIds',
    sql: `SELECT id FROM observations WHERE turn_stopped_at > ? AND scope_key = ?
            ORDER BY turn_stopped_at DESC LIMIT __LIMIT__`,
    params: [DAYS_THRESHOLD, SCOPE], limit: 200,
    verify: () => db.getRecentObservationIds({ scopeKey: SCOPE, days: 90, limit: 200 }),
  },
  {
    line: 1393, method: 'observationTimeline（older）',
    sql: `SELECT * FROM observations
           WHERE scope_key = ?
             AND ( turn_stopped_at < ?
                OR (turn_stopped_at = ? AND turn_seq < ?)
                OR (turn_stopped_at = ? AND turn_seq = ? AND id < ?) )
           ORDER BY turn_stopped_at DESC, turn_seq DESC, id DESC
           LIMIT __LIMIT__`,
    params: [SCOPE, anchor.turn_stopped_at, anchor.turn_stopped_at, anchor.turn_seq,
             anchor.turn_stopped_at, anchor.turn_seq, anchor.id],
    limit: 3,
    // 生产返回的是 `olderDesc.reverse()`（SQL 取 DESC，再翻成时间正序）。
    // 转写的是 SQL 本身，所以这里要把生产结果翻回去才是同一个东西。
    verify: () => [...db.observationTimeline(anchor.id, { before: 3, after: 3 }).before].reverse().map((o) => o.id),
  },
  {
    line: 1405, method: 'observationTimeline（newer）',
    sql: `SELECT * FROM observations
           WHERE scope_key = ?
             AND ( turn_stopped_at > ?
                OR (turn_stopped_at = ? AND turn_seq > ?)
                OR (turn_stopped_at = ? AND turn_seq = ? AND id > ?) )
           ORDER BY turn_stopped_at ASC, turn_seq ASC, id ASC
           LIMIT __LIMIT__`,
    params: [SCOPE, anchor.turn_stopped_at, anchor.turn_stopped_at, anchor.turn_seq,
             anchor.turn_stopped_at, anchor.turn_seq, anchor.id],
    limit: 3,
    verify: () => db.observationTimeline(anchor.id, { before: 3, after: 3 }).after.map((o) => o.id),
  },
  {
    line: 1420, method: 'getPinnedObservations',
    sql: `SELECT * FROM observations WHERE is_pinned = 1 AND scope_key = ?
            ORDER BY turn_stopped_at DESC, id DESC LIMIT __LIMIT__`,
    params: [SCOPE], limit: 10,
    verify: () => db.getPinnedObservations({ scopeKey: SCOPE, limit: 10 }).map((o) => o.id),
  },
  {
    line: 1434, method: 'getRecentObservations',
    sql: `SELECT * FROM observations WHERE scope_key = ?
            ORDER BY turn_stopped_at DESC, id DESC LIMIT __LIMIT__`,
    params: [SCOPE], limit: 20,
    verify: () => db.getRecentObservations({ scopeKey: SCOPE, limit: 20 }).map((o) => o.id),
  },
  {
    line: 1492, method: 'listJobsByState',
    sql: `SELECT * FROM jobs WHERE state = ? ORDER BY priority ASC, available_at ASC, id ASC LIMIT __LIMIT__`,
    params: ['pending'], limit: 50,
    verify: () => db.listJobsByState('pending', 50).map((j) => j.id),
  },
  {
    line: 1544, method: 'findOrphans（turns 无 observation）',
    sql: `SELECT t.id AS id FROM turns t
             LEFT JOIN observations o ON o.turn_id = t.id
            WHERE t.state = 'closed'
              AND o.id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'summarize_turn'
                   AND j.dedupe_key = 'turn:' || t.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY t.id ASC LIMIT __LIMIT__`,
    params: [], limit: 500,
    verify: () =>
      db.findOrphans({ embeddingModel: 'x', embeddingDimensions: 384, limit: 500 })
        .turnsWithoutObservation,
  },
  {
    line: 1565, method: 'findOrphans（observation 无 embedding）',
    sql: `SELECT o.id AS id FROM observations o
             LEFT JOIN observation_embeddings e
               ON e.observation_id = o.id AND e.model = ? AND e.dimensions = ?
              AND length(e.embedding) = ?
            WHERE e.observation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'embed_observation'
                   AND j.dedupe_key = 'embed:obs:' || o.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY o.id ASC LIMIT __LIMIT__`,
    params: ['x', 384, 1536], limit: 500,
    verify: () =>
      db.findOrphans({ embeddingModel: 'x', embeddingDimensions: 384, limit: 500 })
        .observationsWithoutEmbedding,
  },
];

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

const REPEAT = 5;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.floor(s.length / 2)] ?? 0) * 1000) / 1000;
};

const timeIt = (sql: string, params: unknown[]): { ms: number; rows: number } => {
  const stmt = raw.query(sql);
  stmt.all(...(params as never[]));               // 预热，排除 prepare
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < REPEAT; i++) {
    const t = performance.now();
    rows = (stmt.all(...(params as never[])) as unknown[]).length;
    samples.push(performance.now() - t);
  }
  return { ms: median(samples), rows };
};

const planOf = (sql: string, params: unknown[]): string[] =>
  (raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[])
    .map((r) => r.detail);

/** 判据 §3 的翻转判定规则，机械执行。 */
function flipReasons(litPlan: string[], parPlan: string[]): string[] {
  const reasons: string[] = [];
  if (litPlan[0] !== parPlan[0]) reasons.push('驱动表不同');
  const hasTemp = (p: string[]) => p.some((l) => /USE TEMP B-TREE FOR ORDER BY/.test(l));
  if (hasTemp(parPlan) && !hasTemp(litPlan)) reasons.push('参数形式多出 TEMP B-TREE 排序');
  const scanned = (p: string[]) =>
    new Set(p.filter((l) => l.startsWith('SCAN ')).map((l) => l.split(/\s+/)[1]));
  const searched = (p: string[]) =>
    new Set(p.filter((l) => l.startsWith('SEARCH ')).map((l) => l.split(/\s+/)[1]));
  for (const t of scanned(parPlan)) {
    if (searched(litPlan).has(t)) reasons.push(`表 ${t} 从 SEARCH 退化为 SCAN`);
  }
  return reasons;
}

interface Row {
  line: number;
  method: string;
  verified: boolean;
  literal: { ms: number; rows: number; plan: string[] };
  param: { ms: number; rows: number; plan: string[] };
  ratio: number;
  flipped: boolean;
  flipReasons: string[];
  inScope: boolean;
}

const rows: Row[] = [];
for (const s of sites) {
  const litSql = s.sql.replace('__LIMIT__', String(s.limit));
  const parSql = s.sql.replace('__LIMIT__', '?');

  // 转写忠实性：生产方法 vs 转写 SQL，行 id 必须逐条相同。
  //
  // 必须拿**参数形式**去比，不是字面量形式。生产跑的就是 `LIMIT ?`，而这两种形式在
  // bm25 rank 精确平局处会给出不同顺序（实测：L1160 上 8 个平局组、20/49 行，按
  // (rank, id) 归一化后两者一致）。用字面量形式去比会把"平局顺序不同"误报成"转写错了"
  // ——第一版就是这么误报的。
  let verified = false;
  if (s.verify) {
    const prod = s.verify();
    const mine = (raw.query(parSql).all(...([...s.params, s.limit] as never[])) as Record<string, unknown>[])
      .map((r) => Number(r[s.idField ?? 'id']));
    verified = prod.length === mine.length && prod.every((v, i) => v === mine[i]);
    if (!verified) {
      die(
        `L${s.line} ${s.method} 转写与生产方法不一致——审计的是另一条 SQL\n` +
          `  生产 ${prod.length} 行: ${prod.slice(0, 8).join(',')}\n` +
          `  转写 ${mine.length} 行: ${mine.slice(0, 8).join(',')}`,
      );
    }
  }

  const lit = timeIt(litSql, s.params);
  const par = timeIt(parSql, [...s.params, s.limit]);
  const litPlan = planOf(litSql, s.params);
  const parPlan = planOf(parSql, [...s.params, s.limit]);
  const reasons = flipReasons(litPlan, parPlan);
  const ratio = lit.ms === 0 ? 0 : Math.round((par.ms / lit.ms) * 10) / 10;
  // 判据 §3：翻转**且**耗时差异 > 10 倍，两个条件都要满足才纳入修复范围。
  const inScope = reasons.length > 0 && ratio > 10;

  rows.push({
    line: s.line, method: s.method, verified,
    literal: { ...lit, plan: litPlan },
    param: { ...par, plan: parPlan },
    ratio, flipped: reasons.length > 0, flipReasons: reasons, inScope,
  });

  console.log(
    `L${String(s.line).padEnd(5)} ${s.method.padEnd(42)} ` +
      `字面量 ${String(lit.ms).padStart(9)}ms  参数 ${String(par.ms).padStart(9)}ms  ` +
      `×${String(ratio).padStart(7)}  ${reasons.length ? '翻转' : '未翻转'}  ` +
      `${inScope ? '→ 纳入修复' : ''}${s.verify ? '' : ' (无 verify)'}`,
  );
  if (reasons.length) console.log(`        原因：${reasons.join('；')}`);
}

const scope = rows.filter((r) => r.inScope);
console.log(
  `\n[audit] 12 处中：翻转 ${rows.filter((r) => r.flipped).length} 处，` +
    `其中耗时差异 >10× 的 ${scope.length} 处 → 纳入修复：` +
    `${scope.map((r) => `L${r.line}`).join(', ') || '（无）'}`,
);

writeFileSync(
  join(REPORTS_DIR, 'fix-fts-limit-audit.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      provenance: {
        criteria: 'benchmark/reports/fix-fts-limit-criteria.md',
        criteriaSha256: sha16(readFileSync(join(REPORTS_DIR, 'fix-fts-limit-criteria.md'), 'utf-8')),
        fillerSha256: sha16(fillerRaw),
        auditScriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        seededRecords: obsIds.length,
        repeatPerMeasurement: REPEAT,
        flipRule: '驱动表不同 | 参数形式多出 TEMP B-TREE | 某表 SEARCH→SCAN',
        scopeRule: '翻转 AND 耗时比 > 10×',
      },
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log('[audit] 报告：benchmark/reports/fix-fts-limit-audit.json');

raw.close();
db.close();
rmSync(tmpDir, { recursive: true, force: true });
tmpDir = null;
