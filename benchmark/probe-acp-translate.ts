/**
 * 用**生产 ACP 运行时**产出英文镜像（"英文归一化检索"方案的可行性实验）。
 *
 * 要回答的问题：`benchmark/dataset/mirror-en.json` 测出的 en→en MRR 0.972 是**上界**，
 * 不是预测。原因写在 `phase1a-encoder-selection.md` 里——那份镜像是同一个译者、同一
 * 时间、把 query 和记录一起译的，所以两侧的术语选择天然一致。而"入库时译记忆、检索时
 * 译 query"这个方案在生产里是**两次相隔很久、互不参照的翻译事件**：压缩器当时把
 * 「连接池」写成 `runtime pool`，agent 今天写 `connection pool`。那个方差被镜像的
 * 构造方式消掉了，却正是生产里的主噪声源。
 *
 * 所以这个脚本不手写翻译，而是让**真正的生产译者**各译一次：
 *
 *   - `--target=records` 26 条 primary 记录的嵌入字段（模拟 `embed_observation` 侧）
 *   - `--target=queries --query-set=tuned|heldout|empty` 指定一组 query（模拟 agent 侧）
 *
 * 两次是分开的进程调用、分开的 prompt，各自的 prompt 里**不含对侧的任何文本**，所以
 * 独立性是由构造保证的，不是靠约定。逐条也独立：`ACPPool.run()` 每个 prompt 新建
 * session，与生产里每个 turn 一个 session 一致。
 *
 * 纪律上的定位（照 §9 纪律 5）：**它仍然是校准集派生物。** 样本是 `tuned` + 记录侧，
 * `heldout` 不译、也不该译。它举证的是"生产译者的两次独立翻译能不能对齐"，不是泛化。
 *
 * 用法：
 *   bun run benchmark/probe-acp-translate.ts --target=records
 *   bun run benchmark/probe-acp-translate.ts --target=queries
 *   bun run benchmark/probe-acp-translate.ts --target=queries --query-set=heldout
 *   bun run benchmark/probe-acp-translate.ts --target=queries --query-set=empty
 *   bun run benchmark/probe-acp-translate.ts --target=queries --limit=3   # 冒烟
 *
 * 产出可直接喂给排名探针：
 *   bun run benchmark/probe-semantic-rank.ts --subset=tuned --lang=en \
 *     --en-mirror=benchmark/dataset/mirror-en-acp-records.json,benchmark/dataset/mirror-en-acp-queries.json
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { loadDataset, mirroredRecordIds, DATASET_DIR, PHASE2_QUERIES_FILE,
  FUSION_QUERIES_FILE, EMPTY_EXT_QUERIES_FILE } from './dataset';
import type { Annotation, DatasetQuery, DatasetTurn } from './dataset';
import { ACPPool } from '../src/acp';
import { checkSemanticEnQuery } from '../src/semantic-en';
import { loadConfig, resolveRuntimeHome, getDataDir } from '../src/config';
import { checkRuntimeHome, formatIssues } from '../src/acp/integrity';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const target = flag('target') as 'records' | 'queries' | undefined;
if (target !== 'records' && target !== 'queries') {
  console.error('usage: --target=records|queries');
  process.exit(2);
}
const querySet = flag('query-set', 'tuned') as
  'tuned' | 'heldout' | 'empty' | 'leakage' | 'validation' | 'phase2' | 'r2' | 'safety-round';
if (!['tuned', 'heldout', 'empty', 'leakage', 'validation', 'phase2', 'r2', 'safety-round'].includes(querySet)) {
  console.error('unknown --query-set (expected tuned|heldout|empty|leakage|validation|phase2|r2|safety-round)');
  process.exit(2);
}
/**
 * `primary`（默认）只译进入排序池的 26 条；`all` additionally 译 4 条 `scope: other`。
 *
 * 为什么需要 `all`：1a 只做离线 pair 排名，other scope 从不进池，翻译它们是浪费。
 * 但 1b 要跑**完整链路**，而 `semantic-en-v1` 的跨 scope 隔离如果只因为 other scope
 * 压根没有英文向量而成立，那这条证据是假的——泄漏检查必须在两侧都有向量时做。
 */
const recordScope = flag('record-scope', 'primary') as 'primary' | 'all';
if (recordScope !== 'primary' && recordScope !== 'all') {
  console.error('unknown --record-scope (expected primary|all)');
  process.exit(2);
}
/**
 * 记录来源。`turns`（默认）是 `turns.json`；`near-duplicate-pilot` 是安全策略轮次 P2
 * 第 2 步的近重复 pilot（`benchmark/dataset/near-duplicate-pilot.json`）。
 *
 * 为什么复用这个脚本而不新写一个：pilot 要测的分布必须与判据 §5.3 的 0.450 复核带
 * 同源，而那条带子实测由 `mirror-en-acp-records.json` 在 `semantic-en-v1` 下产出
 * （26 条两两 325 对，min −0.072 / p50 0.246 / p95 0.450 / max 0.614 逐位复现）。
 * 换一个译者或换一份 prompt，pilot 的读数就跟那条带子不可比了。复用这里的
 * `recordPrompt` 与 `RECORD_RULES` 是"同一个译者"的构造保证。
 */
const recordSet = flag('record-set', 'turns') as 'turns' | 'near-duplicate-pilot' | 'safety-round-sample';
const RECORD_SET_FILES: Record<string, string> = {
  'near-duplicate-pilot': 'near-duplicate-pilot.json',
  'safety-round-sample': 'turns-safety-round-sample.json',
  'safety-round': 'turns-safety-round.json',
};
if (recordSet !== 'turns' && !RECORD_SET_FILES[recordSet]) {
  console.error(`unknown --record-set (expected turns|${Object.keys(RECORD_SET_FILES).join('|')})`);
  process.exit(2);
}
const limit = Number(flag('limit', '0'));
const concurrency = Number(flag('concurrency', '0'));
const onlyIds = new Set((flag('ids', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
const timeoutMs = Number(flag('timeout-ms', '0'));
const mergeInputs = (flag('merge-inputs', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const defaultSuffix = target === 'queries' && querySet !== 'tuned' ? `-${querySet}` : '';
const defaultRecordSuffix = target === 'records' && recordSet !== 'turns' ? `-${recordSet}` : '';
const outPath = resolve(
  flag('out', join(DATASET_DIR, `mirror-en-acp-${target}${defaultSuffix}${defaultRecordSuffix}.json`))!,
);

// 部分失败后可把 fail-fast 留下的 payload 与定向重试 payload 合成完整固定输入。
// 合并不调用 ACP；来源文件与各自 provenance 全部保留，避免最终成功掩盖首次失败率。
if (mergeInputs.length) {
  const inputs = mergeInputs.map((path) => ({
    path: resolve(path),
    value: JSON.parse(readFileSync(resolve(path), 'utf-8')) as {
      provenance?: Record<string, unknown>; records?: Record<string, unknown>; queries?: Record<string, string>;
    },
  }));
  const merged = target === 'records'
    ? { provenance: { source: 'merged-acp-runs', target, inputs: inputs.map((x) => ({ path: x.path, provenance: x.value.provenance })) }, records: Object.assign({}, ...inputs.map((x) => x.value.records ?? {})) }
    : { provenance: { source: 'merged-acp-runs', target, querySet, inputs: inputs.map((x) => ({ path: x.path, provenance: x.value.provenance })) }, queries: Object.assign({}, ...inputs.map((x) => x.value.queries ?? {})) };
  mkdirSync(dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tempPath, outPath);
  console.log(`[acp-translate] 合并 ${mergeInputs.length} 份固定输入 → ${outPath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

const config = loadConfig();
const kiroHome = resolveRuntimeHome(config.runtime.kiroHome, getDataDir());

// 与 Worker 启动时同一道检查：agent 文件缺失、prompt 缺失、或 `tools` 非空都会让
// 翻译"能跑但不纯"。宁可在这里 fail fast，也不要产出一份来源不明的镜像。
const issues = checkRuntimeHome(kiroHome);
if (issues.length) {
  console.error(`[acp-translate] kiro-runtime 不完整（${kiroHome}）：`);
  console.error(formatIssues(issues));
  console.error('修复：kiro-mem install');
  process.exit(2);
}

const pool = new ACPPool({
  kiroHome,
  agentName: 'kiro-mem-compressor',
  concurrency: concurrency > 0 ? concurrency : config.compression.concurrency,
  timeoutMs: timeoutMs > 0 ? timeoutMs : config.compression.timeoutMs,
});

/**
 * 解析模型返回的 JSON。压缩 agent 的系统 prompt 已经要求"只返回有效 JSON、不要
 * markdown 代码块"，但真实模型偶尔仍会包一层围栏，所以这里剥一次——与
 * `src/acp/compressor.ts` 的容错口径保持一致，不引入新的宽松度。
 */
function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
//
// 两个 prompt 都只含自己那一侧的文本。记录侧看不到任何 query，query 侧看不到任何
// 记录——这就是"两次独立翻译"的构造保证。
//
// "忠实翻译、不要摘要"这条是必须的：镜像的构造规则是**机械 1:1**，一旦译者开始
// 归纳，检索任务就被悄悄换成了另一个任务，读数也就不再可比。
// 路径 / 标识符 / 命令 / 数字保持原样，理由同 `dataset.ts` 里 `files` 不翻译那条：
// 它们是语言中立的高信号字段。

const RECORD_RULES = `规则：
- 忠实翻译，逐句对应。不要摘要、不要补充、不要合并或拆分句子。
- 文件路径、标识符、函数名、命令、配置键、数字、错误码一律原样保留，不要翻译。
- concepts 是短语数组：逐项翻译，数量与顺序必须与输入完全一致。
- 只输出 JSON，不要 markdown 代码块，不要解释。

schema：
{"title": string, "summary": string, "outcome": string, "learned": string, "concepts": string[]}`;

const QUERY_RULES = `规则：
- 忠实翻译这句开发者的口语提问。保持提问语气，不要扩写、不要补充背景。
- 标识符、文件路径、命令、数字一律原样保留，不要翻译。
- 只输出 JSON，不要 markdown 代码块，不要解释。

schema：
{"en": string}`;

function recordPrompt(a: Annotation): string {
  const input = {
    title: a.title,
    summary: a.summary,
    outcome: a.outcome,
    learned: a.learned,
    concepts: a.concepts,
  };
  return `把下面这条开发记忆的字段从中文翻译成英文。\n\n${RECORD_RULES}\n\n待翻译：\n${JSON.stringify(input, null, 2)}`;
}

function queryPrompt(q: string): string {
  return `把下面这句开发者的检索提问从中文翻译成英文。\n\n${QUERY_RULES}\n\n待翻译：\n${q}`;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

// validation 子集在单独文件里，默认不加载（见 dataset.ts 的"只读一次"说明）。
const { turns, queries } = loadDataset(DATASET_DIR, {
  withValidation: querySet === 'validation',
  withPhase2: querySet === 'phase2',
  // `r2` 一次带上两份：fusion 校准集与扩充 empty 集。它们同批冻结、同批生成派生值，
  // 分两次跑会让「派生值一次性生成」这条纪律（规则 §2.5）出现两个时间点。
  withFusion: querySet === 'r2',
  withEmptyExt: querySet === 'r2',
});
/** R2 两份数据集的 id 集合。同样按文件判定，不按 id 前缀。 */
const r2Ids = new Set<string>(
  querySet === 'r2'
    ? [FUSION_QUERIES_FILE, EMPTY_EXT_QUERIES_FILE].flatMap((f) =>
        (JSON.parse(readFileSync(join(DATASET_DIR, f), 'utf-8')) as DatasetQuery[]).map((q) => q.id),
      )
    : [],
);
/** phase2 集的 id 集合。按文件判定而不是按 id 前缀，前缀约定会漂移。 */
const phase2Ids = new Set<string>(
  querySet === 'phase2'
    ? (JSON.parse(
        readFileSync(join(DATASET_DIR, PHASE2_QUERIES_FILE), 'utf-8'),
      ) as DatasetQuery[]).map((q) => q.id)
    : [],
);

interface Item {
  id: string;
  prompt: string;
  /** 解析出的译文；失败为 null。 */
  parse: (json: Record<string, unknown>) => unknown | null;
}

let items: Item[];
if (target === 'records') {
  // pilot 只带 annotation（它刻意不重建 prompt / events，见该文件的 meta 说明），
  // 所以这里取的就是 `{ id, annotation }` 这个最小形状，与 turns 分支共用同一个
  // `recordPrompt` 和同一套 parse 判据。
  const picked: { id: string; annotation: Annotation }[] =
    recordSet !== 'turns'
      ? (
          JSON.parse(
            readFileSync(join(DATASET_DIR, RECORD_SET_FILES[recordSet]!), 'utf-8'),
          ) as { records: { id: string; annotation: Annotation }[] }
        ).records
      : (() => {
          const ids = mirroredRecordIds();
          return turns.filter((t: DatasetTurn) => (recordScope === 'all' ? true : ids.has(t.id)));
        })();
  items = picked.map((t) => ({
    id: t.id,
    prompt: recordPrompt(t.annotation),
    parse: (json) => {
      const concepts = Array.isArray(json.concepts) ? json.concepts.map(str).filter(Boolean) : [];
      const out = {
        title: str(json.title),
        summary: str(json.summary),
        outcome: str(json.outcome),
        learned: str(json.learned),
        concepts,
      };
      // 标题和正文空掉就等于这条记录没被翻译，静默放过会让语料里混进一条空记录。
      if (!out.title || !out.summary) return null;
      // concepts 数量对不上说明译者归纳了——机械 1:1 的前提破了，必须报出来。
      if (concepts.length !== t.annotation.concepts.length) return null;
      return out;
    },
  }));
} else {
  // 安全策略轮次的 query 集在自己的文件里（判据 §7.1 的三个 cohort 都在同一份），
  // 与 turns.json 的 query 无关，因此不走 loadDataset。
  const picked: { id: string; query: string }[] =
    querySet === 'safety-round'
      ? (
          JSON.parse(
            readFileSync(join(DATASET_DIR, 'queries-safety-round.json'), 'utf-8'),
          ) as { queries: { id: string; query: string }[] }
        ).queries
      : queries.filter((q: DatasetQuery) =>
    querySet === 'empty'
      ? q.kind === 'empty'
      : querySet === 'leakage'
        ? q.kind === 'leakage'
        : querySet === 'phase2'
          ? // phase2 集含 relevance 与 empty 两类，且只有中文那部分需要翻译。
            // 英文 query 的 `semantic_query_en` 就是原文本身——护栏明确允许"英文原文
            // 合法地归一化为自身"，所以拿它去跑一次中→英 prompt 是纯浪费，而且 1b 实测
            // 那正是失败最集中的形状（模型倾向回一句解释而不是 JSON）。恒等部分单独补齐。
            phase2Ids.has(q.id) && /[\u4e00-\u9fff]/.test(q.query)
          : querySet === 'r2'
            ? // 与 phase2 同口径：只有含中文那部分需要走中→英 prompt。纯英文 query 的
              // `semantic_query_en` 就是原文本身（护栏明确允许英文原文归一化为自身），
              // 拿它去跑一次翻译 prompt 是纯浪费，且 1b 实测那正是失败最集中的形状。
              // 恒等部分在冻结脚本里单独补齐。
              r2Ids.has(q.id) && /[\u4e00-\u9fff]/.test(q.query)
            : q.kind === 'relevance' && q.origin === querySet,
  );
  items = picked.map((q) => ({
    id: q.id,
    prompt: queryPrompt(q.query),
    parse: (json) => {
      const en = str(json.en).trim();
      if (!en) return null;
      // 过一遍**生产护栏**，不只是"非空即可"。
      //
      // 实测原因：阶段 2 校准集这一跑里，模型对两条 query 返回了字面 `...` ——
      // JSON 合法、字符串非空，于是探针记成 ✓ 并写进固定输入，但生产
      // `checkSemanticEnQuery` 会以 `placeholder` 拒绝它，于是那条 query 在 arm 里
      // 静默落回 raw-v1。探针的成功计数因此**高估**了可用译文数，而高估的那部分
      // 恰好是会污染实验的部分。判据放在这里，失败就走既有的重试与失败队列。
      const check = checkSemanticEnQuery(en, q.query);
      return check.ok ? en : null;
    },
  }));
}

if (limit > 0) items = items.slice(0, limit);
if (onlyIds.size) {
  items = items.filter((item) => onlyIds.has(item.id));
  const missing = [...onlyIds].filter((id) => !items.some((item) => item.id === id));
  if (missing.length) {
    console.error(`[acp-translate] --ids 含不属于当前 target/query-set 的 id: ${missing.join(',')}`);
    process.exit(2);
  }
}

console.log(
  `[acp-translate] target=${target}${target === 'queries' ? ` querySet=${querySet}` : ''} 共 ${items.length} 条 / concurrency=${concurrency > 0 ? concurrency : config.compression.concurrency} / kiroHome=${kiroHome}`,
);

const results = new Map<string, unknown>();
const failures: { id: string; reason: string }[] = [];
const timings: { id: string; durationMs: number; attempts: number }[] = [];
let done = 0;
const startedAt = performance.now();

await Promise.all(
  items.map(async (item) => {
    const itemStartedAt = performance.now();
    // 每条一次重试：JSON 不合法是模型的常见抖动，而一条缺译会让整份镜像不可用
    // （overlay 合并时会静默回落到手写译文，实验就被污染了）。生产的
    // `maxRetries: 2` 是同一个理由，这里取 1 次，因为翻译比压缩简单。
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const res = await pool.run(item.prompt);
        const json = parseJson(res.text);
        const parsed = json ? item.parse(json) : null;
        if (parsed != null) {
          results.set(item.id, parsed);
          timings.push({ id: item.id, durationMs: performance.now() - itemStartedAt, attempts: attempt + 1 });
          console.log(`  [${++done}/${items.length}] ${item.id} ✓`);
          return;
        }
        if (attempt === 1) {
          failures.push({ id: item.id, reason: json ? 'schema 不符（字段空或 concepts 数量不一致）' : 'JSON 解析失败' });
        }
      } catch (err) {
        if (attempt === 1) {
          failures.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    console.log(`  [${++done}/${items.length}] ${item.id} ✗`);
    timings.push({ id: item.id, durationMs: performance.now() - itemStartedAt, attempts: 2 });
  }),
);

await pool.close();

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

const payload =
  target === 'records'
    ? { provenance: buildProvenance(), records: Object.fromEntries(results) }
    : { provenance: buildProvenance(), queries: Object.fromEntries(results) };

function buildProvenance() {
  const sortedMs = timings.map((x) => x.durationMs).sort((a, b) => a - b);
  const pct = (p: number) => sortedMs[Math.min(sortedMs.length - 1, Math.ceil(p * sortedMs.length) - 1)] ?? 0;
  return {
    source: 'acp',
    agent: 'kiro-mem-compressor',
    kiroCli: process.env.KIRO_MEM_BENCH_CLI_VERSION ?? 'kiro-cli (see report)',
    target,
    ...(target === 'queries' ? { querySet } : { recordSet }),
    generatedAt: new Date().toISOString(),
    // 独立性的凭据：两个 target 是分开的进程调用，prompt 里不含对侧文本。
    independence: 'records 与 queries 由两次独立运行产出，prompt 互不含对侧文本',
    items: results.size,
    failures: failures.length,
    retries: timings.filter((x) => x.attempts > 1).length,
    wallTimeMs: Math.round(performance.now() - startedAt),
    itemLatencyMs: { p50: Math.round(pct(0.5)), p95: Math.round(pct(0.95)), max: Math.round(pct(1)) },
  };
}

if (failures.length) {
  const failedPath = `${outPath}.failed-${Date.now()}.json`;
  mkdirSync(dirname(failedPath), { recursive: true });
  writeFileSync(failedPath, JSON.stringify({ ...payload, failuresDetail: failures }, null, 2), 'utf-8');
  console.error(`[acp-translate] 失败 ${failures.length} 条——保留原镜像，失败详情写入 ${failedPath}：`);
  for (const f of failures) console.error(`  ${f.id}: ${f.reason}`);
  process.exit(1);
}

// 全部成功才原子替换固定输入；任何部分失败都不能破坏上一份可复现的 benchmark。
mkdirSync(dirname(outPath), { recursive: true });
const tempPath = `${outPath}.tmp-${process.pid}`;
writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
renameSync(tempPath, outPath);
console.log('');
console.log(`[acp-translate] 成功 ${results.size} / ${items.length}，写入 ${outPath}`);
