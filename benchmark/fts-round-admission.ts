/**
 * FTS 安全策略轮次：**V1 单元覆盖度 + V2 单元 df 上限**的候选准入实现。
 *
 * 判据：`f1-criteria.md`（r3）§2.1（V1 形式）、§2.2（实现形状 C）、§2.3（V2 形式）。
 * 本模块被 S7a 的 K 阶梯与 F3 的网格共用，因此两者跑的是**同一份准入逻辑**——
 * 分开实现会让"阶梯选出的 K"与"网格里用的 K"失去可比性。
 *
 * ## V1（判据 §2.1）
 *
 * 单元先分两类，按生产 `extractFtsSearchUnits` 的两趟结构：
 *   - **精确单元**：pass 1 推出的整段 / 整个 CJK 连续串 / 混排段里的拉丁串
 *     （路径、标识符、数字、版本、整句都在这里）；
 *   - **滑窗单元**：pass 2 的三字滑窗。
 *
 * 准入：`命中 ≥1 个精确单元` **或** `命中的滑窗单元数 ≥ ceil(r × W)`（W = 存活滑窗单元数）。
 * 两条是 OR：前者是豁免（保护专有名词 / 路径 / 数字 / 短查询），后者管中文问句。
 *
 * `r = 0` 时 `ceil(0 × W) = 0`，条件恒真 ⇒ **与生产实现逐条相同**（S6 的恒等锚点）。
 * `W = 0` 时（纯拉丁 / 路径 / 数字）条件恒假，准入完全由精确单元决定 = 今天的行为。
 *
 * ## V2（判据 §2.3）
 *
 * `df / scopeSize > d` 的单元被丢掉，且**同时**退出 OR 表达式与覆盖度计算
 * （分子与分母都不计）。判据没有给精确单元豁免，这里也不给——那会变成第三个变量。
 *
 * 退化边界：全部单元被丢掉时 FTS 腿返回空，**不得回退到 LIKE**（§2.3 写死）。
 *
 * ## 两种实现形状
 *
 *  - `shapeC`：取前 K 个 bm25 候选，在候选内归因后过滤（生产采用的形状，成本与语料规模脱钩）；
 *  - `exact`：逐单元全量 MATCH 探针 + 全量 bm25 序，语义精确，是 K 阶梯的判定基准。
 *
 * 归因用 `instr(lower(col), unit)`：F1 实现探针已实测它与 FTS `MATCH` 归因
 * 在 139 条 query 上逐条一致（`f1-impl-probe.md` §3）。
 *
 * ## 与生产实现的耦合
 *
 * `classifyUnits` 按生产 `extractFtsSearchUnits` 的两趟结构**重算** pass-1 集合
 * （生产返回扁平列表，看不出单元来自哪一趟）。与 F0 的 `pass1Units()` 同一条边界：
 * **生产切分改动后本函数会静默失效**，必须同步。
 */

import type { Database } from 'bun:sqlite';

/** `observations_fts` 索引的 9 列，与 `src/db/schema.ts` 的表定义同序。 */
export const FTS_COLUMNS = [
  'title', 'summary', 'request', 'outcome', 'learned',
  'next_steps', 'concepts_json', 'files_touched_json', 'evidence_json',
] as const;

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{3,}/g;
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RUN_RE = /[A-Za-z0-9_]{3,}/g;
const FTS_MIN_UNIT_LEN = 3;

export interface AdmissionPolicy {
  /** V1：滑窗覆盖度比例。0 = 关闭（准入恒真，等价于今天的行为）。 */
  windowCoverageRatio: number;
  /** V2：单元 df/scopeSize 上限。1.0 = 关闭。 */
  unitDfRatioCeiling: number;
}

/** 按生产两趟结构重算的 pass-1（精确）单元集合。 */
export function pass1Units(query: string): Set<string> {
  const out = new Set<string>();
  for (const segment of query.trim().split(/\s+/)) {
    if (!segment) continue;
    if (segment.length >= FTS_MIN_UNIT_LEN) out.add(segment);
    for (const run of segment.match(CJK_RUN_RE) ?? []) out.add(run);
    if (CJK_CHAR_RE.test(segment)) for (const run of segment.match(LATIN_RUN_RE) ?? []) out.add(run);
  }
  return out;
}

export interface ClassifiedUnits {
  /** 生产切分给出的全部单元，原序。 */
  all: string[];
  exact: string[];
  window: string[];
}
export function classifyUnits(query: string, units: string[]): ClassifiedUnits {
  const p1 = pass1Units(query);
  return { all: units, exact: units.filter((u) => p1.has(u)), window: units.filter((u) => !p1.has(u)) };
}

const quote = (u: string): string => `"${u.replaceAll('"', '""')}"`;
const orExpr = (units: string[]): string => units.map(quote).join(' OR ');

export interface AdmissionContext {
  raw: Database;
  scopeKey: string;
  scopeSize: number;
  /** 单元 df 缓存；跨 arm 复用，因为 df 只取决于装置。 */
  dfCache: Map<string, number>;
}

export function unitDf(ctx: AdmissionContext, unit: string): number {
  const hit = ctx.dfCache.get(unit);
  if (hit !== undefined) return hit;
  const n = (ctx.raw.query(
    `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o ON fts.rowid = o.id
       WHERE observations_fts MATCH ? AND o.scope_key = ?`,
  ).all(quote(unit), ctx.scopeKey) as { n: number }[])[0]!.n;
  ctx.dfCache.set(unit, n);
  return n;
}

export interface SurvivingUnits extends ClassifiedUnits {
  dropped: { unit: string; df: number; dfRatio: number }[];
  /** 存活滑窗单元数，即覆盖度公式里的 W。 */
  W: number;
  /** 覆盖度门槛 `ceil(r × W)`。 */
  required: number;
}

/** V2：按 df 上限筛单元；随后算出 V1 的门槛。 */
export function surviveUnits(
  ctx: AdmissionContext, query: string, units: string[], policy: AdmissionPolicy,
): SurvivingUnits {
  const dropped: { unit: string; df: number; dfRatio: number }[] = [];
  const kept = units.filter((u) => {
    const df = unitDf(ctx, u);
    const ratio = df / ctx.scopeSize;
    if (ratio > policy.unitDfRatioCeiling) { dropped.push({ unit: u, df, dfRatio: ratio }); return false; }
    return true;
  });
  const cls = classifyUnits(query, kept);
  const W = cls.window.length;
  return { ...cls, dropped, W, required: Math.ceil(policy.windowCoverageRatio * W) };
}

/** 候选行在 9 列上命中了哪些单元（`instr`，与 MATCH 归因实测等价）。 */
function attribute(ctx: AdmissionContext, ids: number[], units: string[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  if (!ids.length || !units.length) return out;
  const params: (string | number)[] = [];
  const cols = units.map((u) => {
    const ors = FTS_COLUMNS.map((c) => `instr(lower(coalesce(o.${c}, '')), ?) > 0`).join(' OR ');
    for (const _ of FTS_COLUMNS) params.push(u.toLowerCase());
    return `(CASE WHEN ${ors} THEN 1 ELSE 0 END)`;
  });
  const rows = ctx.raw.query(
    `SELECT o.id AS id, ${cols.map((c, i) => `${c} AS u${i}`).join(', ')}
       FROM observations o WHERE o.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...params, ...ids) as Record<string, number>[];
  for (const row of rows) {
    const set = out.get(row.id!)!;
    units.forEach((u, i) => { if (row[`u${i}`]) set.add(u); });
  }
  return out;
}

/** V1 准入判定：精确单元豁免 OR 滑窗覆盖度达标。 */
export function admits(hit: Set<string>, s: SurvivingUnits): boolean {
  if (s.exact.some((u) => hit.has(u))) return true;
  if (s.W === 0) return false;
  return s.window.filter((u) => hit.has(u)).length >= s.required;
}

export interface LegResult {
  ids: number[];
  /** 准入前的候选数（形状 C 是窗口内的条数，exact 是全量匹配数）。 */
  candidates: number;
  /** 该 query 的单元构成与门槛。 */
  units: SurvivingUnits;
  /** 走的是哪条分支：`fts` / `like`（短查询）/ `empty`（V2 丢空）。 */
  branch: 'fts' | 'like' | 'empty';
  /** 因精确单元豁免而准入的条数（判据 §5.4 的读数）。 */
  exemptHits: number;
}

/**
 * 形状 C：取前 K 个 bm25 候选，在候选内归因后过滤，返回至多 `limit` 条。
 *
 * 短查询（无单元）走生产 LIKE 回退，V1/V2 都不作用于它（判据 §2.1 边界 2）。
 */
export function legShapeC(
  ctx: AdmissionContext, db: { searchObservationsFts: Function }, query: string,
  units: string[], policy: AdmissionPolicy, K: number, limit = 50,
): LegResult {
  if (units.length === 0) {
    const ids = (db.searchObservationsFts(query, { scopeKey: ctx.scopeKey, limit }) as { id: number }[]).map((o) => o.id);
    return { ids, candidates: ids.length, units: { all: [], exact: [], window: [], dropped: [], W: 0, required: 0 }, branch: 'like', exemptHits: 0 };
  }
  const s = surviveUnits(ctx, query, units, policy);
  if (s.all.length === 0) {
    return { ids: [], candidates: 0, units: s, branch: 'empty', exemptHits: 0 };
  }
  const cand = (ctx.raw.query(
    `SELECT o.id AS id FROM observations_fts fts CROSS JOIN observations o ON fts.rowid = o.id
       WHERE observations_fts MATCH ? AND o.scope_key = ? ORDER BY fts.rank, o.id ASC LIMIT ?`,
  ).all(orExpr(s.all), ctx.scopeKey, K) as { id: number }[]).map((r) => r.id);
  const hits = attribute(ctx, cand, s.all);
  const ids: number[] = [];
  let exemptHits = 0;
  for (const id of cand) {
    const h = hits.get(id) ?? new Set<string>();
    if (!admits(h, s)) continue;
    if (s.exact.some((u) => h.has(u))) exemptHits++;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return { ids, candidates: cand.length, units: s, branch: 'fts', exemptHits };
}

/**
 * 精确形状：逐单元全量 MATCH 探针 + 全量 bm25 序。
 *
 * 差集为 0 由构造保证（它就是形状 C 在 K = ∞ 时的语义），因此它是 K 阶梯的判定基准。
 * 归因用 FTS 自己的语义而不是 `instr`，所以它同时是 `instr` 归因的对照。
 */
export function legExact(
  ctx: AdmissionContext, db: { searchObservationsFts: Function }, query: string,
  units: string[], policy: AdmissionPolicy, limit = 50,
): LegResult {
  if (units.length === 0) {
    const ids = (db.searchObservationsFts(query, { scopeKey: ctx.scopeKey, limit }) as { id: number }[]).map((o) => o.id);
    return { ids, candidates: ids.length, units: { all: [], exact: [], window: [], dropped: [], W: 0, required: 0 }, branch: 'like', exemptHits: 0 };
  }
  const s = surviveUnits(ctx, query, units, policy);
  if (s.all.length === 0) return { ids: [], candidates: 0, units: s, branch: 'empty', exemptHits: 0 };

  const perUnit = new Map<number, Set<string>>();
  for (const u of s.all) {
    const rows = ctx.raw.query(
      `SELECT fts.rowid AS id FROM observations_fts fts CROSS JOIN observations o ON fts.rowid = o.id
         WHERE observations_fts MATCH ? AND o.scope_key = ?`,
    ).all(quote(u), ctx.scopeKey) as { id: number }[];
    for (const r of rows) {
      const set = perUnit.get(r.id) ?? new Set<string>();
      set.add(u);
      perUnit.set(r.id, set);
    }
  }
  const ranked = ctx.raw.query(
    `SELECT o.id AS id FROM observations_fts fts CROSS JOIN observations o ON fts.rowid = o.id
       WHERE observations_fts MATCH ? AND o.scope_key = ? ORDER BY fts.rank, o.id ASC`,
  ).all(orExpr(s.all), ctx.scopeKey) as { id: number }[];

  const ids: number[] = [];
  let exemptHits = 0;
  for (const r of ranked) {
    const h = perUnit.get(r.id) ?? new Set<string>();
    if (!admits(h, s)) continue;
    if (s.exact.some((u) => h.has(u))) exemptHits++;
    ids.push(r.id);
    if (ids.length >= limit) break;
  }
  return { ids, candidates: ranked.length, units: s, branch: 'fts', exemptHits };
}

/** 网格的 16 个 arm（判据 §2 的刻度，arm id 格式 `r<r>-d<d>`）。 */
export const GRID_R = [0, 0.1, 0.2, 0.3] as const;
export const GRID_D = [1.0, 0.3, 0.1, 0.03] as const;
export const armId = (r: number, d: number): string => `r${r}-d${d.toFixed(2)}`;
export const ALL_ARMS: { id: string; policy: AdmissionPolicy }[] = GRID_R.flatMap((r) =>
  GRID_D.map((d) => ({ id: armId(r, d), policy: { windowCoverageRatio: r, unitDfRatioCeiling: d } })),
);
export const BASELINE_ARM = armId(0, 1.0);
