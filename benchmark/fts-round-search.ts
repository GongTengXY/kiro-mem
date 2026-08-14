/**
 * FTS 安全策略轮次 **F3：把 V1/V2 准入接进完整检索链的注入接缝**。
 *
 * 判据：`f1-criteria.md`（r3）§2.2（实现形状 C）、§5.4（准入读数）、§7 S6（恒等锚点）。
 * 冻结：`f2-freeze-r3.json`（K = 200、装置、四档）。
 *
 * ## 为什么需要它
 *
 * F2 只跑了 FTS 腿（`legShapeC` / `legExact`）。F3 的门有一半在**融合之后**才成立：
 * G3 的 `match_source`、semantic-only cap、G1 的页面位置、G2 的整页 `distinctContent`。
 * 因此 F3 必须跑生产的 `hybridSearchObservations`，只把它的 FTS 腿换掉。
 *
 * ## 形式：代理 `MemoryDB`，只替换 `searchObservationsFts`
 *
 * **生产代码零改动**（F2 报告的前提，F3 继续维持）。生产检索内核在
 * `observation-search.ts:539` 处调用 `db.searchObservationsFts(...)`，代理拦住这一个方法，
 * 其余方法 `.bind()` 到真实实例后原样转发——所以 `this.db` 永远解析到真实句柄，
 * 不依赖 Proxy 的属性转发链。
 *
 * ## 两条必须断言的边界
 *
 * 准入腿的候选 SQL **没有 `days` 与 `type` 过滤器**（`fts-round-admission.ts`），
 * 而生产调用会把 `days`/`type` 传进来。本轮的冻结策略是"默认时间窗无界、不带 type"，
 * 所以两者当前等价；但**等价是条件性的**，一旦条件变了而代理还在静默丢过滤器，
 * 那就成了判据 §9 第 8 条禁止的"第三个变量"。因此代理在每次调用时断言：
 *
 *   - `opts.type` 必须是 undefined；
 *   - `opts.days` 必须是 `DEFAULT_SEARCH_DAYS`（= Infinity）；
 *   - `opts.limit` 必须是 50（V4 冻结值，FTS 腿返回内核的条数）。
 *
 * 任一不符即抛错，不返回近似结果。
 *
 * ## `r = 0` 的恒等性
 *
 * `ceil(0 × W) = 0` ⇒ 准入条件恒真 ⇒ 基线臂返回与生产逐条相同。这不是巧合而是构造，
 * F2 已在 FTS 腿上验过 120/120；S6 在完整检索链上再验一次。
 */

import type { Database } from 'bun:sqlite';

import { DEFAULT_SEARCH_DAYS, type MemoryDB } from '../src/db';
import type { Observation } from '../src/db/types';
import {
  legExact, legShapeC, type AdmissionContext, type AdmissionPolicy, type LegResult,
} from './fts-round-admission';

/** FTS 腿返回给检索内核的条数（V4，判据 §2.5 冻结不动）。 */
export const INTERNAL_CANDIDATE_LIMIT = 50;

/** 一次搜索里 FTS 腿的准入读数（判据 §5.4）。 */
export interface AdmissionReading {
  branch: LegResult['branch'];
  /** 准入前候选数：形状 C 是窗口内条数，`exact` 是全量匹配数。 */
  candidates: number;
  /** 准入后存活并返回给内核的条数。 */
  admitted: number;
  /** 滑窗单元数 W（V2 丢弃后的存活数）。 */
  W: number;
  /** 覆盖度门槛 `ceil(r × W)`。 */
  required: number;
  exactUnits: number;
  /** 被 V2 丢掉的单元及其 df 比例。 */
  dropped: { unit: string; df: number; dfRatio: number }[];
  /** 因精确单元豁免而准入的条数（§11 预测二的验证读数）。 */
  exemptHits: number;
  /** 全部单元被 V2 丢空：FTS 腿返回空且不得回退 LIKE（§2.3）。 */
  droppedEmpty: boolean;
}

export interface AdmissionSearchHandle {
  /** 传给 `hybridSearchObservations` 的 db。 */
  db: MemoryDB;
  /** 最近一次 FTS 腿调用的读数；每次搜索前由 runner 读走。 */
  last: () => AdmissionReading | null;
  /** FTS 腿被调用的次数，用于自证"代理确实生效了"。 */
  calls: () => number;
}

export interface AdmissionSearchOpts {
  policy: AdmissionPolicy;
  /** 形状 C 的候选窗口；`'EXACT'` 走精确语义（K 阶梯的终点）。 */
  k: number | 'EXACT';
  scopeKey: string;
  scopeSize: number;
  /** 跨 arm 复用的 df 缓存。性能读数必须传一个**每次计时前清空**的缓存。 */
  dfCache: Map<string, number>;
  /** 生产切分结果；由 runner 预先算好并按 query 复用。 */
  unitsOf: (query: string) => string[];
}

/**
 * 包出一个"FTS 腿走 V1/V2 准入"的 db 代理。
 *
 * 返回的 `db` 只在 `searchObservationsFts` 上与真实实例不同；其余方法（向量、行取回、
 * scope 计数）全部是真实实现，因此语义腿、RRF 融合、tie-break、cap 全部是生产逻辑。
 */
export function withAdmissionLeg(real: MemoryDB, opts: AdmissionSearchOpts): AdmissionSearchHandle {
  const raw = (real as unknown as { db: Database }).db;
  const ctx: AdmissionContext = {
    raw, scopeKey: opts.scopeKey, scopeSize: opts.scopeSize, dfCache: opts.dfCache,
  };
  let last: AdmissionReading | null = null;
  let calls = 0;

  const admissionFts = (
    query: string,
    o?: { scopeKey?: string; type?: string; days?: number; limit?: number },
  ): Observation[] => {
    // --- 边界断言（见文件头）---
    if (o?.type !== undefined) throw new Error(`[f3-search] 准入腿不支持 type 过滤：${o.type}`);
    const days = o?.days ?? DEFAULT_SEARCH_DAYS;
    if (days !== DEFAULT_SEARCH_DAYS) throw new Error(`[f3-search] 准入腿只支持无界时间窗，收到 days=${days}`);
    if ((o?.limit ?? 20) !== INTERNAL_CANDIDATE_LIMIT) {
      throw new Error(`[f3-search] FTS 腿的 limit 必须是冻结的 ${INTERNAL_CANDIDATE_LIMIT}，收到 ${o?.limit}`);
    }
    if (o?.scopeKey !== opts.scopeKey) throw new Error(`[f3-search] scopeKey 不符：${o?.scopeKey}`);

    calls++;
    const units = opts.unitsOf(query);
    const leg = opts.k === 'EXACT'
      ? legExact(ctx, real, query, units, opts.policy, INTERNAL_CANDIDATE_LIMIT)
      : legShapeC(ctx, real, query, units, opts.policy, opts.k, INTERNAL_CANDIDATE_LIMIT);

    last = {
      branch: leg.branch,
      candidates: leg.candidates,
      admitted: leg.ids.length,
      W: leg.units.W,
      required: leg.units.required,
      exactUnits: leg.units.exact.length,
      dropped: leg.units.dropped,
      exemptHits: leg.exemptHits,
      droppedEmpty: leg.branch === 'empty',
    };

    if (leg.ids.length === 0) return [];
    // 还原成 Observation 行，并保持准入腿给出的 bm25 序 —— 内核用返回顺序建 ftsRank，
    // 顺序错了 RRF 就错了。
    const byId = new Map(real.getObservationsByIds(leg.ids).map((o2) => [o2.id, o2]));
    return leg.ids.map((id) => byId.get(id)).filter((o2): o2 is Observation => o2 !== undefined);
  };

  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'searchObservationsFts') return admissionFts;
      const value = Reflect.get(target, prop, receiver);
      // 绑定到真实实例：`this.db` 因此永远是真实句柄，不经过本代理的属性转发。
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MemoryDB;

  return { db: proxy, last: () => last, calls: () => calls };
}
