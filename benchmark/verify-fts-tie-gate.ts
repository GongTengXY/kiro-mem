/** 验证 B1 修订门槛：FTS 腿的输出差异是否严格限制在 bm25 精确平局组内。 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'kiro-gate-'));
const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');
const { Database } = await import('bun:sqlite');
const { loadDataset, annotationToResult, DATASET_DIR } = await import('./dataset');
const dbPath = join(tmp, 'g.db');
const db = new MemoryDB(dbPath);

const ds = loadDataset(DATASET_DIR, { withValidation: true, withPhase2: true, withFusion: true, withEmptyExt: true });
const CWD = { primary: '/proj/kiro-mem', other: '/proj/other-app' } as const;
const BASE = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 30 * 86400000;
const nameOf = new Map<number, string>();
let clock = 0;
for (const t of ds.turns) {
  const cwd = CWD[t.scope]; const sid = `s-${t.scope}`;
  if (!db.getSessionRef(sid)) db.upsertSessionRef({ session_id: sid, cwd, repo: cwd });
  const seq = db.allocateNextTurnSeq(sid);
  const turn = db.createTurn({ session_id: sid, seq, cwd, repo: cwd, prompt_text: t.prompt });
  const ts = new Date(BASE + clock++ * 60000).toISOString();
  db.markTurnClosed(turn.id, ts);
  const r = annotationToResult(t.annotation);
  const oid = db.insertObservation({
    turn_id: turn.id, session_id: sid, turn_seq: seq, repo: cwd, cwd_scope: cwd,
    title: r.title, summary: r.summary, request: r.request, outcome: r.outcome, learned: r.learned,
    next_steps: r.next_steps, memory_type: r.memory_type as never, files_touched: r.files_touched,
    concepts: r.concepts, evidence: r.evidence, quality: 'normal',
    turn_started_at: ts, turn_stopped_at: ts,
  })!;
  nameOf.set(oid, t.id);
}

const raw = new Database(dbPath, { readonly: true });
const THR = new Date(Date.now() - 90 * 86400000).toISOString();

/** 三种形态：修复前（JOIN，无平局键）、中间态（CROSS JOIN，无平局键）、当前（CROSS JOIN + id ASC）。 */
const forms = {
  'pre-fix   (JOIN,       rank)': `SELECT o.id AS id, fts.rank AS rank FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
      ORDER BY fts.rank LIMIT ?`,
  'mid       (CROSS JOIN, rank)': `SELECT o.id AS id, fts.rank AS rank FROM observations_fts fts
      CROSS JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
      ORDER BY fts.rank LIMIT ?`,
  'current   (CROSS JOIN, rank+id)': `SELECT o.id AS id, fts.rank AS rank FROM observations_fts fts
      CROSS JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
      ORDER BY fts.rank, o.id ASC LIMIT ?`,
};

let violations = 0;
let tieQueries = 0;
const details: string[] = [];

for (const q of ds.queries) {
  const units = extractFtsSearchUnits(q.query.trim());
  if (!units.length) continue;
  const expr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
  const scope = computeScopeKey(CWD[q.scope], CWD[q.scope]);
  const out: Record<string, { id: number; rank: number }[]> = {};
  for (const [k, sql] of Object.entries(forms)) {
    out[k] = raw.query(sql).all(expr, THR, scope, 50) as { id: number; rank: number }[];
  }
  const pre = out['pre-fix   (JOIN,       rank)']!;
  const cur = out['current   (CROSS JOIN, rank+id)']!;
  if (!pre.length) continue;

  // 平局组
  const groups = new Map<string, number[]>();
  for (const r of pre) {
    const k = r.rank.toFixed(12);
    groups.set(k, [...(groups.get(k) ?? []), r.id]);
  }
  const tiedIds = new Set<number>();
  for (const ids of groups.values()) if (ids.length > 1) for (const i of ids) tiedIds.add(i);
  if (tiedIds.size) tieQueries++;

  // 门槛一：成员不变
  const sameMembers = pre.length === cur.length &&
    new Set(pre.map(r=>r.id)).size === new Set([...pre, ...cur].map(r=>r.id)).size;

  // 门槛二：非平局记录的相对顺序不变
  const nonTiedPre = pre.filter((r) => !tiedIds.has(r.id)).map((r) => r.id);
  const nonTiedCur = cur.filter((r) => !tiedIds.has(r.id)).map((r) => r.id);
  const sameNonTiedOrder = nonTiedPre.length === nonTiedCur.length &&
    nonTiedPre.every((v, i) => v === nonTiedCur[i]);

  // 门槛三：平局组内部按 id ASC
  let tieOrderOk = true;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const inCur = cur.filter((r) => ids.includes(r.id)).map((r) => r.id);
    const expected = [...ids].sort((a, b) => a - b);
    if (inCur.length !== expected.length || !inCur.every((v, i) => v === expected[i])) tieOrderOk = false;
  }

  if (!sameMembers || !sameNonTiedOrder || !tieOrderOk) {
    violations++;
    details.push(
      `${q.id}: 成员${sameMembers ? '同' : '异'} 非平局顺序${sameNonTiedOrder ? '同' : '异'} ` +
      `平局内 id ASC ${tieOrderOk ? '是' : '否'}`,
    );
  }
  if (tiedIds.size && details.length < 6) {
    const g = [...groups.entries()].filter(([, ids]) => ids.length > 1);
    details.push(
      `  ${q.id} 平局组: ${g.map(([, ids]) => ids.map((i) => `${nameOf.get(i)}(id${i})`).join('=')).join(' | ')}` +
      `  →  当前次序 ${cur.filter(r=>tiedIds.has(r.id)).map(r=>nameOf.get(r.id)).join(',')}`,
    );
  }
}

console.log(`有 FTS 命中的 query 中，含 bm25 精确平局的: ${tieQueries}`);
console.log(`违反 B1 修订门槛的 query: ${violations}`);
console.log('\n明细：');
for (const d of details) console.log('  ' + d);

raw.close(); db.close();
rmSync(tmp, { recursive: true, force: true });
