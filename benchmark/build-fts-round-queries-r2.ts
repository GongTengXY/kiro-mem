#!/usr/bin/env bun
/**
 * 生成 `queries-fts-round-r2.json`：按预检的**实测结果**修 query，其余原样保留。
 *
 * 判据：`f1-criteria-r4.md` §15（只改 query token，不改记录正文）、§16（四道资格门）。
 *
 * 为什么用补丁表而不是手抄一份新文件：补丁表**就是**改动清单——每条写明原值、新值、
 * 依据的实测 token 及其 df。手抄 120 条既看不出改了什么，也容易在复制时引入新错。
 *
 * 两类改动，逐条对应预检的失败门：
 *
 *  - **Q2 失败的 26 条词面负例**：锚点改成**记录/语料里逐字存在的 ≥4 字中文短语**，
 *    并把该短语写进 query 文本。这样 `extractFtsSearchUnits` 切出的三字窗完整落在短语内部，
 *    窗口 df 由构造 ≥ 1。原来的两字锚点（`滑窗` / `记录`）在三字窗下结构性不可达（F0-2）。
 *  - **Q3/Q4 失败的 12 条保护线**：token 换成该 gold **可索引字段**里真实存在的
 *    标识符 / 路径 / 数字。`semanticFloor` / `Clopper-Pearson` / `97/109` 只存在于
 *    `fact_source` 与 `key_facts`，那两个字段不进 Observation，因此不可用（§15）。
 *
 * 每条改动都带 `token_source`（`indexed-field` / `synthetic-filler`，r4 §18 的机械门）
 * 与 `measured_df`（实测值，来自预检的 token 建议输出）。
 *
 * 用法：bun run benchmark/build-fts-round-queries-r2.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATASET = join(import.meta.dir, 'dataset');
const SRC = join(DATASET, 'queries-fts-round.json');
const OUT = join(DATASET, 'queries-fts-round-r2.json');

interface Patch {
  query?: string;
  lexical_anchor?: string;
  token_source: 'indexed-field' | 'synthetic-filler';
  measured_df: number;
  /** 改动理由，进数据文件，供复核逐条核对。 */
  repair: string;
  primary_gold?: string[];
  acceptable_gold?: string[];
  annotation_basis?: string;
}

/** 词面负例：锚点改成实测存在的 ≥4 字中文短语，并写进 query 文本。 */
const NEG: Record<string, Patch> = {
  'fr-a01': { query: '位移门存在的那个计数是按每条结果的权重加起来算的吗', lexical_anchor: '位移门存在', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「排序污染」的三字窗在语料里对不上邻字；改用 n04 正文里逐字存在的短语。' },
  'fr-a06': { query: '在词面腿里切出来的窗口长度是按提问长度自动调整的吗', lexical_anchor: '在词面腿里', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「滑窗」两字，三字窗跨过它时两侧邻字对不上（F0-2）；改用 n06 正文短语。' },
  'fr-a07': { query: '同一道门在两层上的读数最后会按层加权合成一个总分吗', lexical_anchor: '同一道门在两层', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「分层报告」不可达；改用 n09 标题里的短语。' },
  'fr-a08': { query: '零观测只能给出上界的时候，会同时给出双侧置信区间吗', lexical_anchor: '只能给出上界', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「置信上界」不可达；改用 n23 标题短语。' },
  'fr-a11': { query: '轮灌轮次表是按农户报名先后排的吗', lexical_anchor: '轮灌轮次表', token_source: 'synthetic-filler', measured_df: 1000, repair: '锚点补全为合成语料里逐字存在的完整表名。' },
  'fr-a12': { query: '存在真实取舍曲线的那个方向，最优点是脚本自动求出来的吗', lexical_anchor: '在真实取舍', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「取舍曲线」的窗口在语料里对不上；改用 n18 标题短语。' },
  'fr-a13': { query: '冻结自证的记录是带自增版本号并覆盖上一份的吗', lexical_anchor: '冻结自证', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「冻结记录」不可达；改用 n12 标题短语。' },
  'fr-a15': { query: '装置自证那四个数一起看的时候，包含多机之间的一致性检查吗', lexical_anchor: '四个数一起', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「装置自证」不可达；改用 n33 标题短语。' },
  'fr-a16': { query: '结论依赖模型版本的时候，复现信息里要不要记录硬件指纹', lexical_anchor: '依赖模型', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「复现信息」不可达；改用 n29 标题短语。' },
  'fr-a19': { query: '与冻结值逐位相同的那批记录，压缩质量是分几档评的', lexical_anchor: '与冻结值', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「分档」不可达；改用 n34 标题短语，问的仍是压缩质量分档这件不存在的事。' },
  'fr-a20': { query: '试次之间必须完全隔离，那用户数据在磁盘上的隔离和清理策略是怎样的', lexical_anchor: '完全隔离', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「隔离」两字不可达；改用 n21 标题短语。' },
  'fr-a21': { query: '误召回装置里按字节截断丢掉的原始载荷还能补回来吗', lexical_anchor: '召回装置', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「截断」两字不可达；改用 n05 标题短语。' },
  'fr-a22': { query: '补跑必须走预登记状态机，那检索会按时间局部性优先返回最近的记录吗', lexical_anchor: '必须走预', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「时间局部性」不可达；改用 n27 标题短语。' },
  'fr-a23': { query: '判定依据只给了一侧的那种情况，代码评审时以哪份权威文件为准', lexical_anchor: '判定依据', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「权威文件」不可达；改用 n26 标题短语。' },
  'fr-a24': { query: '那四个数一起看里的降级计数，指的是压缩失败写进去的那条记录吗', lexical_anchor: '数一起看', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「降级」两字不可达；改用 n33 标题短语。' },
  'fr-a26': { query: '向量与冻结值重建之后，全文索引什么时候需要整个重建一次', lexical_anchor: '向量与冻', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「重建」两字不可达；改用 n34 标题短语。' },
  'fr-a27': { query: '取证不阻塞门集冻结、两条线并行推进的时候，压缩子进程的并行数默认是多少', lexical_anchor: '不阻塞门', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「并行」两字不可达；改用 n38 标题短语。' },
  'fr-a28': { query: '清空页面即通过的那种情形，网页界面上一页显示多少条记录', lexical_anchor: '清空页面', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「页面」两字不可达；改用 n04 标题短语。' },
  'fr-a29': { query: '四周预警之后系统异常是怎么通知到运维的', lexical_anchor: '四周预警', token_source: 'synthetic-filler', measured_df: 182, repair: '原锚点「预警」两字不可达，改成的「缺口预警」实测在语料里 0 行（又一次未测量就断言）；改用实测存在的「四周预警」（182 行）。' },
  'fr-a32': { query: '中文竞争池的上限现在还是两百条吗', lexical_anchor: '中文竞争', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「候选池」在语料里子串出现 0 行（凭印象断言，缺陷 2）；改用 n19 正文短语。' },
  'fr-a33': { query: '检索返回页的默认时间窗现在还是限制在九十天吗', lexical_anchor: '检索返回', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「时间窗」在语料里子串出现 0 行（缺陷 2）；改用 n15 标题短语。' },
  'fr-a35': { query: '预登记状态机里每格的有效试次是从二十降到十的吗', lexical_anchor: '登记状态', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「有效试次」不可达；改用 n27 标题短语。' },
  'fr-a37': { query: '与冻结值逐位相同的向量现在还是用全精度存的吗', lexical_anchor: '值逐位相', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「向量」两字不可达；改用 n34 标题短语。' },
  'fr-a38': { query: '填充语料只贡献十三行的那份语料，是从两千条扩到一万条的吗', lexical_anchor: '充语料只', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「填充语料」不可达；改用 n36 标题短语。' },
  'fr-a39': { query: '排序取证与准入取证原来的三条轨道后来合并成两条了吗', lexical_anchor: '准入取证', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「取证轨道」不可达；改用 n37 标题短语。' },
  'fr-a40': { query: '零命中是相对语料成立的那批记录，保留期限是从九十天延长到一年了吗', lexical_anchor: '命中是相对', token_source: 'indexed-field', measured_df: 1, repair: '原锚点「记录」两字虽在 10,012 行里，但三字窗不可达；改用 n13 标题短语。' },
};

/** 保护线：token 换成 gold 可索引字段里真实存在的值（§15）。 */
const PROT: Record<string, Patch> = {
  'fr-p02': {
    query: 'mcp-server', token_source: 'indexed-field', measured_df: 5,
    primary_gold: ['n30'], acceptable_gold: ['n30', 'n07'],
    annotation_basis: '拉丁标识符，来自 n30 的 files_touched（src/server/mcp-server.ts），实测 df=5。n30 讲的正是在这一层做转发改写而生产卡片构造不动。原 token「match_source」只存在于 fact_source，不进 Observation 可索引字段（r4 §15）。',
    repair: 'match_source 只在非索引字段里，换成 gold 可索引字段里的标识符；primary 相应从 n07 改为 n30（n07 的 primary 覆盖由 fr-r40 承担）。',
  },
  'fr-p13': { query: 'run-safety-round-grid', token_source: 'indexed-field', measured_df: 8, annotation_basis: '拉丁标识符，来自 n04 的 files_touched（benchmark/run-safety-round-grid.ts），实测 df=8。n04 的事实来源正是该脚本里那段位移计数实现。', repair: 'primary_gold 这个 token 只存在于 fact_source；换成 gold 可索引字段里的脚本名。' },
  'fr-p14': { query: 'observation-search', token_source: 'indexed-field', measured_df: 9, annotation_basis: '拉丁标识符，来自 n01 的 files_touched（src/server/observation-search.ts），实测 df=9。n01 讲的是该文件里地板线只约束语义候选这件事。', repair: 'semanticFloor 只存在于 fact_source；换成 gold 可索引字段里的模块名。' },
  'fr-p15': { query: 'analyze-fts-anchor-mechanism', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n20'], acceptable_gold: ['n20'], annotation_basis: '拉丁标识符，来自 n20 的 files_touched（benchmark/analyze-fts-anchor-mechanism.ts），实测 df=1。n20 讲的正是该脚本里那份重算的单元分类。', repair: 'extractFtsSearchUnits 只存在于 fact_source；换成 gold 可索引字段里的脚本名，primary 同步指向该脚本所属记录。' },
  'fr-p17': { query: 'embedding', token_source: 'indexed-field', measured_df: 4, primary_gold: ['n34'], acceptable_gold: ['n34'], annotation_basis: '拉丁标识符，来自 n34 的 files_touched（src/embedding.ts），实测 df=4。n34 讲的是重建向量与冻结值逐位相同。', repair: 'semantic-en-v1 只存在于 fact_source；换成 gold 可索引字段里的模块名，primary 从 n33 改为 n34（n33 的覆盖由 fr-r29 承担）。' },
  'fr-p18': { query: 'q6-criteria', token_source: 'indexed-field', measured_df: 9, annotation_basis: '拉丁标识符，来自 n23 的 files_touched（benchmark/reports/agent-behavior/q6-criteria.md），实测 df=9。n23 讲的正是该判据里零观测上界的分母口径。', repair: 'Clopper-Pearson 只存在于 fact_source；换成 gold 可索引字段里的文件名。' },
  'fr-p19': { query: 's1-precheck', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n39'], acceptable_gold: ['n39'], annotation_basis: '拉丁标识符，来自 n39 的 files_touched（benchmark/q6/s1-precheck.ts），实测 df=1。n39 讲的正是该预检替代了不可执行的自证项。', repair: 'freeze-util 在任何 gold 的可索引字段里都不存在；换成 gold 可索引字段里的脚本名，primary 从 n12 改为 n39（n12 的覆盖由 fr-r08 承担）。' },
  'fr-p28': { query: '0.0156', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n08'], acceptable_gold: ['n08'], annotation_basis: '四位小数形态，逐字出现在 n08 的正文（最小可达显著性），实测 df=1。', repair: '4.87% 在记录正文里写成了中文「百分之四点八七」，投影里没有该数字串；换成 gold 正文里真实存在的数值。' },
  'fr-p29': { query: '4.955', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n10'], acceptable_gold: ['n10'], annotation_basis: '三位小数形态，逐字出现在 n10 的标题与正文（去重返回起点），实测 df=1。', repair: '50066 在记录正文里写成中文「五万零六十六」；换成 gold 正文里真实存在的数值。' },
  'fr-p30': { query: '1.565', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n11'], acceptable_gold: ['n11'], annotation_basis: '三位小数形态，逐字出现在 n11 的正文（零词面命中层的起点），实测 df=1。', repair: '97/109 在记录正文里写成中文「一百零九行里九十七行」；换成 gold 正文里真实存在的数值。' },
  'fr-p33': { query: '0.841', token_source: 'indexed-field', measured_df: 1, primary_gold: ['n16'], acceptable_gold: ['n16'], annotation_basis: '三位小数形态，逐字出现在 n16 的正文（查询级区分度），实测 df=1。', repair: '18.5 在记录正文里写成中文「十八点五个」；换成 gold 正文里真实存在的数值。' },
  'fr-p34': { query: '误召回门现在还是原来那四道吗', token_source: 'indexed-field', measured_df: 1, annotation_basis: '已变更状态且语料里有变更记录，属 stale-state relevance（P2 判据 §4.2）。n03 的标题逐字含「误召回门」，实测窗口 df=1，因此该 gold 在词面分支可达而不是空门。', repair: '原问法的三字窗在 n03 上全部对不上，基线不可达即空门；改成含 n03 标题短语的问法。' },
};

// --- 应用补丁 ----------------------------------------------------------------
const src = JSON.parse(readFileSync(SRC, 'utf-8')) as { meta: Record<string, unknown>; queries: any[] };
const patches: Record<string, Patch> = { ...NEG, ...PROT };
const applied: string[] = [];

const queries = src.queries.map((q) => {
  const p = patches[q.id];
  if (!p) {
    // 未改动的条目也要带 token_source（r4 §18 的机械门），按其锚点来源标注。
    if (q.cohort === 'lexical-anchor') {
      return { ...q, token_source: q.anchor_source === 'synthetic-filler' ? 'synthetic-filler' : 'indexed-field' };
    }
    if (q.cohort === 'protection') return { ...q, token_source: 'indexed-field' };
    return q;
  }
  applied.push(q.id);
  const next = { ...q };
  if (p.query !== undefined) { next.query_r1 = q.query; next.query = p.query; }
  if (p.lexical_anchor !== undefined) { next.lexical_anchor_r1 = q.lexical_anchor; next.lexical_anchor = p.lexical_anchor; }
  if (p.primary_gold) { next.primary_gold_r1 = q.primary_gold; next.primary_gold = p.primary_gold; }
  if (p.acceptable_gold) next.acceptable_gold = p.acceptable_gold;
  if (p.annotation_basis) next.annotation_basis = p.annotation_basis;
  next.token_source = p.token_source;
  next.measured_df = p.measured_df;
  next.repair = p.repair;
  return next;
});

const missing = Object.keys(patches).filter((id) => !applied.includes(id));
if (missing.length) { console.error(`[queries-r2] ✗ 补丁表里有不存在的 id：${missing.join(' ')}`); process.exit(1); }

writeFileSync(OUT, `${JSON.stringify({
  meta: {
    ...src.meta,
    step: 'F1 数据段 r2：按预检实测结果修 query（判据 r4 §15 / §16）。',
    round: 'fts-safety-round-2026-08-12-r2',
    criteria: 'benchmark/reports/fts-round/f1-criteria-r4.md',
    baselineCriteria: 'benchmark/reports/fts-round/f1-criteria.md',
    criteriaRevision: 'r3',
    r1Source: 'benchmark/dataset/queries-fts-round.json（逐字节保留，未修改）',
    patchScript: 'benchmark/build-fts-round-queries-r2.ts',
    patched: applied.length,
    patchedIds: applied,
    unchanged: queries.length - applied.length,
    note: '改动条目保留 query_r1 / lexical_anchor_r1 / primary_gold_r1 字段，便于逐条核对改了什么；每条带 token_source 与 measured_df。',
  },
  queries,
}, null, 2)}\n`);

console.log(`[queries-r2] 补丁 ${applied.length} 条（负例 ${Object.keys(NEG).length} + 保护线 ${Object.keys(PROT).length}），未改 ${queries.length - applied.length} 条`);
console.log(`[queries-r2] → ${OUT}`);
