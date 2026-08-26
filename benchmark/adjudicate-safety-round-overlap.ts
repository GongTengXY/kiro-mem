/**
 * P2 第 4 步第 2 阶段：复核带的**逐对裁决生成器**。
 *
 * 判据 §5.2 的裁决规则是按事实来源判，不按余弦：
 *
 *   同一事实 / 同一修复 / 同一结果   → duplicate，删除一个
 *   同一领域但不同工作               → related，保留
 *   能共同回答同一 query             → 加入 acceptable_gold（候选，逐 query 再判）
 *
 * 为了让"是不是同一事实"这件事可审计，这里给每条记录写下**它唯一回答的那个问题**
 * （`QUESTION`）。裁决规则于是变成一句可复核的话：
 *
 *   两条记录回答的是同一个问题 → duplicate；不同问题 → related。
 *
 * 这不是把判断自动化——`QUESTION` 是人写的，`OVERRIDE` 里的每条特判也是人写的。
 * 自动化的只有"把裁决铺到每一对上"这个机械动作，因为复核带要求穷举，
 * 而 77 对里绝大多数的理由就是"这两个问题不同"。
 *
 * 裁决 1.4（执行裁定 §1.4）：`related` **不等于**自动进入 `acceptable_gold`。
 * 本文件只产出 `acceptableGoldCandidate` 标记，真正的判断要在写 query 时逐条做。
 *
 * 用法：bun run benchmark/adjudicate-safety-round-overlap.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const DIR = join(import.meta.dir, 'reports', 'safety-round');
const SCREEN = join(DIR, 'p2-overlap-screen-safety-round.json');
const OUT = join(DIR, 'p2-overlap-adjudication-safety-round.json');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[adj] ✗ ${m}`); process.exit(1); };

/** 每条记录唯一回答的问题。写不出一个与其他记录都不同的问题，就说明这条记录不该单独存在。 */
const QUESTION: Record<string, string> = {
  // --- 已过审的 8 条 ---
  s01: '只译记录侧、query 不译这个省事方案能不能用',
  s02: '向量空间的版本键该包含哪些成分',
  s03: '最终盲审的误召回门过没过，回滚时间窗能不能救',
  s04: '装置里的复印件把误召回读数抬高了多少',
  s05: '用相对语料背景做准入这条规则到底有没有信号',
  s06: '默认时间窗从多少改成了多少',
  s07: '同一条检索 SQL 参数化之后为什么慢一千多倍',
  s08: '每页 2 条这个上限约束的是哪一部分',
  // --- 检索机制 ---
  c09: '融合打分用不用相似度分数的大小',
  c10: '候选池边界与排名保留边界是不是一回事',
  c11: '策略参数填了非法值会怎样',
  c12: '回滚档的四个参数值分别是多少',
  c13: '缺少合法英文提问形式时检索实际走的是哪条路径',
  c14: '能不能为 raw 空间单独校准一个地板线',
  c15: '中文双字切分辅助腿第二轮的结果是什么',
  c16: '默认无界之后天数参数的上限与 schema 默认值怎么写',
  // --- 误召回与门槛 ---
  c17: '当前地板线是在多大规模的语料上选出来的',
  c18: '地板线在五万条上实际筛掉了多少语料',
  c19: '报告里那个稳定的二百条语义候选是什么',
  c20: '提高地板线能不能清空完全异域的假线索',
  c21: '技术相近那类负例能不能靠提高地板线压到门槛之下',
  c22: '提高地板线的真实代价有多大',
  c23: '独立盲审确认的召回收益是多少',
  c24: '时间窗改动带来的页面替换幅度有多大',
  c25: '页面被副本占满有没有掩盖本该找回的正例',
  c26: '把每页配额降到 1 能不能让误召回门自动通过',
  // --- 规模与装置 ---
  c27: '保留一千名在最大语料档的延迟与内存是多少',
  c28: '截断保留集会不会改变返回的页面',
  c29: '五万条那个装置是怎么搭出来的',
  c30: '填充语料怎么保证不与校准 query 产生词面命中',
  // --- 注入、MCP 与配置 ---
  c31: '会话开始时注入的索引有多大预算',
  c32: '按 id 取详情的响应上限是多少',
  c33: '切回旧档需不需要重建向量、会不会丢数据',
  c34: '改完配置怎么不读代码就确认生效',
  // --- 排序与轮次归属 ---
  c35: '关键词排序次序键里的 id 升序携带什么意见',
  c36: '排序取证能不能并进当前这一轮',
  // --- 纪律与边界 ---
  c37: '已消耗的验收集还能不能拿来调参',
  c38: '换成分位数或差值写法能不能绕开相对准入的缺陷',
  c39: '结果去重要不要并进当前这一轮',
  c40: '候选网格为什么要按规则等距铺开',
  c41: 'benchmark 嵌入的文本和生产是不是逐字节一致',
  // --- 旧 26 条（只列进入复核带的那几条） ---
  t06: 'MCP 入参的边界校验与 pin 的错误返回怎么做',
  t18: '注入到会话里的索引实际占多少字节',
  t20: 'timeline 该锚定 Observation ID 还是 source turn',
  t21: 'RRF 融合与 0.2 语义地板线是怎么定的',
  t26: '质量基准集在内测和对外发布上分别是什么要求',
};

/**
 * 特判。只有两类：
 *   duplicate —— 两条回答同一个问题，必须删一条；
 *   related-with-correction —— 问题不同，但其中一条的正文**顺带复述了**另一条的核心事实，
 *     要在候选阶段把复述那句删掉，让每条记录只主张自己的事实。
 */
const OVERRIDE: Record<string, { verdict: string; reason: string; action: string }> = {
  's06×c16': {
    verdict: 'duplicate',
    reason:
      's06 的 summary 已经明写「原先分散在四处的 90 天兜底全部清掉：……以及 MCP schema 里的默认值」，' +
      '而这正是 c16 的核心事实。c16 唯一多出来的是 1–3650 这个夹取范围，而它是防笔误的实现细节，' +
      '不足以支撑一条独立记录。两条引的还是同一个 commit b1df06f。按判据 §5.2「同一事实 → 删除一个」。',
    action: 'c16 从最终集合移除（s06 已在第 3 步过审，保留 s06）。3650 这个上限并入 s06 不做——那会改动已过审的文本。',
  },
  'c12×c33': {
    verdict: 'related-with-correction',
    reason:
      '两个问题不同：c12 答「回滚档的四个值是多少」，c33 答「回滚要不要重建数据、什么时候生效」。' +
      '但 c12 的 summary 末句「开关只改检索行为，不动库结构、存储向量与嵌入协议」把 c33 的核心事实复述了一遍，' +
      '这才是 0.752 的来源。',
    action: '删掉 c12 summary 与 assistant_response 里那句复述，让 c12 只主张四个参数值，c33 只主张作用范围与生效时机。两条都保留。',
  },
};

const screen = read(SCREEN);
const pairs: { key: string; a: string; b: string; cosine: number; scope: string }[] = [
  ...screen.layer2ReviewBand.entries.map((e: any) => ({
    key: `${e.newId}×${e.oldId}`, a: e.newId, b: e.oldId, cosine: e.cosine, scope: 'new-vs-old',
  })),
  ...screen.withinNewSet.entries.map((e: any) => ({
    key: `${e.a}×${e.b}`, a: e.a, b: e.b, cosine: e.cosine, scope: 'within-new-set',
  })),
];

const missingQ = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].filter((id) => !QUESTION[id]);
if (missingQ.length) die(`这些记录没写下它唯一回答的问题：${missingQ.join(', ')}`);

/**
 * 已生效的处置：`OVERRIDE` 里的对在当前筛查结果中已经不存在了，说明处置被执行过
 * （删掉了一条记录，或改掉了那句复述，余弦掉出复核带）。这类记录必须留在报告里——
 * 它们是"复核确实动过东西"的凭据，而不是可以静默消失的中间态。
 */
const resolved = Object.entries(OVERRIDE)
  .filter(([key]) => !pairs.some((p) => p.key === key))
  .map(([key, o]) => ({ pair: key, ...o, status: 'applied — 该对已不在复核带内' }));

const rulings = pairs.map((p) => {
  const o = OVERRIDE[p.key];
  if (o) return { pair: p.key, cosine: p.cosine, scope: p.scope, ...o, questionA: QUESTION[p.a], questionB: QUESTION[p.b] };
  if (QUESTION[p.a] === QUESTION[p.b]) {
    die(`${p.key} 两条记录写的是同一个问题，必须显式裁决为 duplicate 并写进 OVERRIDE`);
  }
  return {
    pair: p.key,
    cosine: p.cosine,
    scope: p.scope,
    verdict: 'related',
    reason: `分别回答「${QUESTION[p.a]}」与「${QUESTION[p.b]}」——同一领域、不同问题，事实不重叠。`,
    action: '两条都保留。',
    questionA: QUESTION[p.a],
    questionB: QUESTION[p.b],
    acceptableGoldCandidate: 'pending-per-query',
  };
});

const out = {
  meta: {
    step: 'P2 第 4 步第 2 阶段：复核带逐对裁决',
    criteria: 'benchmark/reports/safety-round/p2-calibration-criteria.md §5.2',
    executionRuling: 'benchmark/reports/safety-round/p2-step3-review-and-step4-ruling.md',
    screen: 'benchmark/reports/safety-round/p2-overlap-screen-safety-round.json',
    screenSha256: createHash('sha256').update(readFileSync(SCREEN)).digest('hex'),
    band: 0.45,
    autoDeleteEnabled: false,
    method:
      '每条记录先写下它唯一回答的问题；两条回答同一问题即 duplicate，不同问题即 related。' +
      '余弦只决定哪几对进入本表，不参与裁决。',
    acceptableGoldNote:
      '裁决 1.4：related 不等于自动进入 acceptable_gold。本表只标 pending-per-query，' +
      '真正的判断在写 query 时逐条做（范围含新 40 条与旧 26 条）。',
  },
  counts: {
    pairs: rulings.length,
    newVsOld: rulings.filter((r) => r.scope === 'new-vs-old').length,
    withinNewSet: rulings.filter((r) => r.scope === 'within-new-set').length,
    duplicate: rulings.filter((r) => r.verdict === 'duplicate').length,
    relatedWithCorrection: rulings.filter((r) => r.verdict === 'related-with-correction').length,
    related: rulings.filter((r) => r.verdict === 'related').length,
    resolvedAndApplied: resolved.length,
  },
  resolved,
  questions: QUESTION,
  rulings,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');

console.log(`[adj] ${rulings.length} 对：duplicate ${out.counts.duplicate} / related-with-correction ${out.counts.relatedWithCorrection} / related ${out.counts.related}`);
for (const r of rulings.filter((x) => x.verdict !== 'related')) {
  console.log(`   ${r.verdict.toUpperCase()}  ${r.pair} (${r.cosine})`);
  console.log(`      ${r.action}`);
}
for (const r of resolved) console.log(`   APPLIED  ${r.pair} → ${r.verdict}（已生效，不在复核带内）`);
console.log(`[adj] 写入 ${OUT}`);
