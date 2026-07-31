/**
 * 基准数据集的**唯一**契约定义：类型、加载、标注自检，以及"一条标注 turn 对应
 * 什么样的 Observation"这个映射。
 *
 * 为什么要单独一个模块：`run.ts` 之外还有两个离线 probe（`probe-semantic-rank.ts`
 * / `probe-similarity-dist.ts`）需要同一份东西。probe 里手抄一份映射，就等于给
 * "gold Observation 长什么样"造了第二个事实来源——而它一漂移，probe 测的就是另一
 * 个语料，却会把差异报成编码器的成绩。方案 §4.4 为了同样的理由选择给检索内核加
 * 观测出口，而不是在 harness 里复制一份 FTS 调用。
 *
 * `annotationSearchText()` 更关键：它必须与生产 `embed_observation` job 嵌入的
 * 文本逐字节一致，所以它不自己拼字符串，而是复用 `src/embedding.ts` 里的
 * `buildObservationSearchText()`。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ObservationSummaryResult } from '../src/compressor';
import type { SemanticEnRecord } from '../src/semantic-en';
import { buildObservationSearchText } from '../src/embedding';
import type { KeyFact } from './scoring';

export interface DatasetEvent {
  tool: string;
  input: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface Annotation {
  request: string;
  completed: boolean;
  memory_type: string;
  /** 关键文件：应出现在 Observation.files_touched 中 */
  key_files: string[];
  /**
   * 可核对事实标记：应保留在 Observation 正文中。按 token 边界匹配，语序与
   * 中间插入的词不影响判定；需要接受中英/同义表达时写成 `{ any: [...] }`，
   * 让"什么算同一个事实"留在可审阅的数据里，而不是藏在打分器的启发式里。
   */
  key_facts: KeyFact[];
  /** 未完成项：非空时 next_steps 必须非空 */
  unfinished: string[];
  /** 不允许出现的断言（虚构完成状态检测） */
  forbidden_claims?: string[];
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}

export interface DatasetTurn {
  id: string;
  scope: 'primary' | 'other';
  session: string;
  prompt: string;
  assistant_response: string;
  events: DatasetEvent[];
  annotation: Annotation;
}

export interface DatasetQuery {
  id: string;
  /**
   * relevance — 有应命中的标注 Observation，度量召回与排序。
   * leakage   — 只检验跨 scope 硬隔离；**可以**有本 scope 的合法命中。
   * empty     — 本 scope 内既无相关记忆也无合法词汇重叠，理想返回空。
   *
   * `empty` 必须显式声明，不能用 `expect.length === 0` 推断：leakage 类的
   * `expect` 也是空的，但它空的含义是"不该返回**别的 scope**的记录"，不是
   * "什么都不该返回"。q20 就是反例——它故意与本 scope 的 401/token 词汇重叠，
   * 按 `expect: []` 推断会把正确的关键词命中记成误召回，指标于是惩罚了正确
   * 行为（与 B6 打分器缺陷同一类错误）。
   */
  kind: 'relevance' | 'leakage' | 'empty';
  /**
   * 仅 relevance 有意义：这条 query 是否参与过检索实现的调优。
   *
   * `tuned`   — 最初的 18 条。D1（FTS 召回恒为 0）就是靠它们发现并修的，
   *             `benchmark/README.md` 自述那次修复让 gold hit@5 从 66.7% 升到
   *             94.4%，所以检索实现确实是在这批 query 上调过的。
   * `heldout` — 后补的 18 条，写完直接测、不据此改任何检索参数。它们才是泛化
   *             证据：两个子集的 hit@5 若明显分叉，就是 B4 说的过拟合从"风险"
   *             变成"事实"。
   *
   * 这个划分不完美——同一个人写的标注、同一份 turn 语料——但它比"完全没有
   * heldout"强，而且成本只是多标一个字段。
   *
   * 方案 §5.6 在此之上定了**统一划分**：`tuned` + `empty` 是校准集（选编码器、
   * 定 floor、定阈值只能在这里发生），`heldout` 是验证集（每阶段只读一次，
   * 不参与任何选择）。
   *
   * `validation` — 阶段 1b 新标注的一批（`queries-validation.json`），中英文各 10 条。
   *   为什么还要一批：v7 的探索过程实际查看过 heldout（q16 的占位符异常就是在那里
   *   发现并据此加了护栏），所以现有 heldout 已经降级为**确认集**，不能再声称无偏。
   *   这一批在实现冻结之后才写、只读一次、不据此改任何参数或 prompt；它是"英文归一化
   *   到底能不能泛化"这个问题上唯一还没被消耗掉的样本。
   *
   *   诚实边界：它由实现者本人按 `turns.json` 的标注写的，且写的时候已经看过 tuned /
   *   heldout 的结果——所以它比"完全独立的第三方标注"弱。它强的地方只有一处：这些
   *   具体问法从未参与过任何选择。报告里必须带上这句限定。
   */
  origin?: 'tuned' | 'heldout' | 'validation';
  scope: 'primary' | 'other';
  query: string;
  expect: string[];
  note?: string;
}

export interface Dataset {
  turns: DatasetTurn[];
  queries: DatasetQuery[];
}

/** 数据集目录（`benchmark/dataset/`）。 */
export const DATASET_DIR = join(import.meta.dir, 'dataset');

/** 新增验证集文件。默认**不加载**——见 `loadDataset` 的说明。 */
export const VALIDATION_QUERIES_FILE = 'queries-validation.json';

/**
 * 加载数据集。
 *
 * `withValidation` 默认 false，这是刻意的：把 20 条新 query 混进默认 `bun run bench`
 * 会改动全局 `hitAt5` / `mrr`，而 `queries.json` 的 hash 一个字节没变——报告于是自称
 * 同一份数据集却给出不同的数字。更重要的是"只读一次"这条纪律：显式开关让每一次读取
 * 都留在命令行里，而不是被默认行为悄悄消耗掉。
 */
export function loadDataset(dir = DATASET_DIR, opts?: { withValidation?: boolean }): Dataset {
  const queries = JSON.parse(
    readFileSync(join(dir, 'queries.json'), 'utf-8'),
  ) as DatasetQuery[];
  if (opts?.withValidation) {
    queries.push(
      ...(JSON.parse(readFileSync(join(dir, VALIDATION_QUERIES_FILE), 'utf-8')) as DatasetQuery[]),
    );
  }
  return {
    turns: JSON.parse(readFileSync(join(dir, 'turns.json'), 'utf-8')) as DatasetTurn[],
    queries,
  };
}

/**
 * 标注自检。返回错误列表而不是直接退出——调用方（harness / probe）自己决定怎么
 * 报错。标注自相矛盾会静默产出错误指标：expected-empty 就是这么被算错过一次。
 */
export function validateQueries(queries: DatasetQuery[]): string[] {
  const errors: string[] = [];
  for (const q of queries) {
    const wantsHits = q.kind === 'relevance';
    if (wantsHits !== q.expect.length > 0) {
      errors.push(
        `${q.id}: kind=${q.kind} 与 expect(${q.expect.length} 条) 矛盾` +
          `（relevance 必须有应命中项，leakage/empty 必须没有）`,
      );
    }
    // origin 决定这条 query 算不算泛化证据，缺省就等于把 heldout 混进 tuned。
    if (wantsHits && q.origin !== 'tuned' && q.origin !== 'heldout' && q.origin !== 'validation') {
      errors.push(`${q.id}: relevance query 必须声明 origin: "tuned" | "heldout" | "validation"`);
    }
  }
  return errors;
}

/**
 * 一条标注 → gold 压缩器的输出。`run.ts` 的 GoldCompressor 与两个 probe 共用它。
 */
export function annotationToResult(a: Annotation): ObservationSummaryResult {
  return {
    title: a.title,
    summary: a.summary,
    request: a.request,
    outcome: a.outcome,
    learned: a.learned,
    next_steps: a.unfinished.join('；'),
    memory_type: a.memory_type,
    files_touched: a.key_files,
    concepts: a.concepts,
    // key_facts 可能带变体声明；gold 取第一个写法作为 evidence 文本。
    evidence: a.key_facts.map((f) => (typeof f === 'string' ? f : f.any[0] ?? '')),
    importance_score: 0.6,
    confidence_score: a.completed ? 0.9 : 0.5,
    unresolved_score: a.unfinished.length ? 0.7 : 0,
  };
}

/**
 * 一条标注在**生产向量空间**里对应的嵌入文本。
 *
 * 不自己拼：走 `annotationToResult` 再走生产的 `buildObservationSearchText`，
 * 所以 probe 嵌入的就是 `embed_observation` job 会嵌入的那段文本。任何一端改了
 * 拼接规则，两端一起变。
 */
export function annotationSearchText(a: Annotation): string {
  const r = annotationToResult(a);
  return buildObservationSearchText({
    title: r.title,
    summary: r.summary,
    outcome: r.outcome,
    learned: r.learned,
    concepts: r.concepts,
    files: r.files_touched,
  });
}

// ---------------------------------------------------------------------------
// 英文镜像（跨语言编码器对比用）
// ---------------------------------------------------------------------------

/**
 * 语言模式。
 *
 * - `zh`    原始中文语料 + 中文 query。1a 的主对比。
 * - `en`    英文记录 + 英文 query。回答"这个编码器能不能服务英文用户"——kiro-mem
 *           的 `language` 支持 `en`，而压缩产出的 Observation 语言跟随用户 prompt
 *           语言，所以英文用户的**语料本身**也是英文，EN→EN 才是真实场景。
 * - `cross` 英文 query + 中文记录。回答跨语言对齐能力（双语用户，或历史记录是中文
 *           但现在用英文提问）。
 * - `zh2en` 中文 query + 英文记录。**方向与 `cross` 相反**，1a 没测这一格。
 *
 * 中文专用编码器的风险只在 `en` / `cross` 下暴露，`zh` 一栏永远看不出来。
 *
 * `zh2en` 为什么值得单独一格：它是"入库时把记忆译成英文、query 侧一个字不改"这个
 * 方案的**唯一**读数。四格里 1a 只测了三格，缺的正是这一格，于是那个方案（工程面积
 * 最小的一版——不动 MCP 入参、不动 agent prompt、只在 embed 侧多一列译文）在数据上
 * 无法判断。补它的成本接近零：英文镜像和 query 两侧的取文本函数本来就是分开的。
 *
 * 已知的机制性怀疑（所以这一格更可能是否证而不是证实）：`all-MiniLM-L6-v2` 的词表
 * 30522 个 token 里只有 244 个纯 CJK，中文 query 的多数字符落成 `[UNK]`，向量本身
 * 就在退化区域里（方案 §1.1：4 条互不相关的 query 共享同一个最近邻 t26）。记录侧改
 * 成英文修不到这一半。`cross` 那格 0.704 > `zh` 那格 0.529 也指向同一件事——那两格
 * 的唯一差别就是 query 语言。
 */
export type ProbeLang = 'zh' | 'en' | 'cross' | 'zh2en';

/** 记录侧是否取英文镜像。`en` 与 `zh2en` 取，`zh` 与 `cross` 不取。 */
export function usesEnRecords(lang: ProbeLang): boolean {
  return lang === 'en' || lang === 'zh2en';
}

/** query 侧是否取英文镜像。`en` 与 `cross` 取，`zh` 与 `zh2en` 不取。 */
export function usesEnQueries(lang: ProbeLang): boolean {
  return lang === 'en' || lang === 'cross';
}

interface EnMirror {
  records: Record<
    string,
    { title: string; summary: string; outcome: string; learned: string; concepts: string[] }
  >;
  queries: Record<string, string>;
}

let enMirrorCache: EnMirror | null = null;

export function loadEnMirror(dir = DATASET_DIR): EnMirror {
  if (!enMirrorCache) {
    enMirrorCache = JSON.parse(readFileSync(join(dir, 'mirror-en.json'), 'utf-8')) as EnMirror;
  }
  return enMirrorCache;
}

/**
 * 用另一份译文覆盖当前镜像的 `records` / `queries`。
 *
 * 存在的理由：`mirror-en.json` 的 0.972 是**同一个译者同时译两侧**得到的上界，而
 * "入库译记忆 + 检索译 query"这个方案在生产里是两次互不参照的翻译事件。要读出后者
 * 的真实分数，就得能把任一侧换成独立产出的译文（见 `probe-acp-translate.ts`）。
 *
 * 覆盖是**逐 key 合并**而不是整体替换，这样才能跑出译者来源的 2×2 分解
 * （手写记录 × 手写 query / ACP 记录 × ACP query / 两个交叉组合）。
 *
 * 但逐 key 合并有个陷阱必须挡住：**覆盖文件缺了哪一条，那一条就静默回落到手写译文**，
 * 于是实验里混进了它本想排除的那个变量。所以这里返回覆盖计数，由调用方对着期望条数
 * 断言——`probe-semantic-rank.ts` 不匹配就直接退出。
 */
export function applyEnMirrorOverlay(path: string): { records: number; queries: number } {
  const base = loadEnMirror();
  const overlay = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EnMirror>;
  let records = 0;
  let queries = 0;
  for (const [id, rec] of Object.entries(overlay.records ?? {})) {
    base.records[id] = rec;
    records++;
  }
  for (const [id, q] of Object.entries(overlay.queries ?? {})) {
    base.queries[id] = q;
    queries++;
  }
  return { records, queries };
}

/**
 * 一条记录在指定语言下的嵌入文本。
 *
 * `files` 一律取中文标注里的 `key_files`：路径是语言中立的，翻译它就会让检索任务
 * 变成另一个任务。`cross` 模式的记录侧就是中文，与 `zh` 相同。
 */
export function recordSearchText(turn: DatasetTurn, lang: ProbeLang): string {
  if (!usesEnRecords(lang)) return annotationSearchText(turn.annotation);
  const m = loadEnMirror().records[turn.id];
  if (!m) throw new Error(`mirror-en.json 缺少记录 ${turn.id}`);
  return buildObservationSearchText({
    title: m.title,
    summary: m.summary,
    outcome: m.outcome,
    learned: m.learned,
    concepts: m.concepts,
    files: turn.annotation.key_files,
  });
}

/** 一条 query 在指定语言下的文本。`en` 与 `cross` 的 query 侧是英文，`zh2en` 是中文。 */
export function queryText(q: DatasetQuery, lang: ProbeLang): string {
  if (!usesEnQueries(lang)) return q.query;
  const m = loadEnMirror().queries[q.id];
  if (!m) throw new Error(`mirror-en.json 缺少 query ${q.id}（英文镜像只覆盖 tuned + empty）`);
  return m;
}

/** 英文镜像覆盖到的 query id。probe 用它来拒绝跑镜像没覆盖的子集。 */
export function mirroredQueryIds(): Set<string> {
  return new Set(Object.keys(loadEnMirror().queries));
}

/**
 * 英文镜像覆盖到的记录 id（= 26 条 primary）。
 *
 * `scope: other` 的 4 条故意不镜像：它们只为跨 scope 隔离检查而存在，从不进入
 * primary 的排序池，翻译它们纯属浪费。probe 在 `--lang=en` 下据此过滤语料。
 */
export function mirroredRecordIds(): Set<string> {
  return new Set(Object.keys(loadEnMirror().records));
}

// ---------------------------------------------------------------------------
// 阶段 1b：生产协议固定输入（ACP 产出的 semantic-en-v1 派生值）
// ---------------------------------------------------------------------------

/**
 * `semantic-en-v1` 的固定输入：记录侧派生值 + query 侧英文形式，全部由
 * `probe-acp-translate.ts` 用**生产 ACP 运行时**产出。
 *
 * 为什么 A/B 用固定输入而不是每轮现译：现译会把"翻译这一轮抽到了什么"混进检索
 * 读数里，两个 arm 就不再只差一个变量。运行可靠性是另一码事，由 §10 纪律要求的
 * fresh ACP 首轮成功率单独度量，不能拿这份固定输入冒充。
 *
 * 覆盖必须是**全量**的：缺一条就会在 arm B 里静默变成 raw 协议（query 侧）或没有
 * 英文向量（记录侧），于是"英文归一化的效果"里混进了"有几条压根没归一化"。
 * `assertAcpEnFixtureComplete()` 因此是硬失败，不是警告。
 */
export interface AcpEnFixture {
  records: Record<string, SemanticEnRecord>;
  queries: Record<string, string>;
  /** 参与合并的文件名，写进报告 provenance。 */
  sources: string[];
}

const ACP_EN_RECORD_FILES = [
  'mirror-en-acp-records.json',
  // scope: other 的 4 条。1a 不需要，1b 需要——否则"跨 scope 无泄漏"可能只是因为
  // 那 4 条根本没有英文向量，那条证据就是假的。
  'mirror-en-acp-records-other.json',
];
const ACP_EN_QUERY_FILES = [
  'mirror-en-acp-queries.json',
  'mirror-en-acp-queries-heldout.json',
  'mirror-en-acp-queries-empty.json',
  'mirror-en-acp-queries-leakage.json',
];
/** 新增验证集的英文形式，与 `queries-validation.json` 一起显式加载。 */
const ACP_EN_VALIDATION_QUERY_FILE = 'mirror-en-acp-queries-validation.json';

export function loadAcpEnFixture(
  dir = DATASET_DIR,
  opts?: { withValidation?: boolean },
): AcpEnFixture {
  const records: Record<string, SemanticEnRecord> = {};
  const queries: Record<string, string> = {};
  const queryFiles = opts?.withValidation
    ? [...ACP_EN_QUERY_FILES, ACP_EN_VALIDATION_QUERY_FILE]
    : ACP_EN_QUERY_FILES;
  for (const file of ACP_EN_RECORD_FILES) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as {
      records?: Record<string, SemanticEnRecord>;
    };
    Object.assign(records, parsed.records ?? {});
  }
  for (const file of queryFiles) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as {
      queries?: Record<string, string>;
    };
    Object.assign(queries, parsed.queries ?? {});
  }
  return { records, queries, sources: [...ACP_EN_RECORD_FILES, ...queryFiles] };
}

/** 返回缺失项；调用方（harness）自己决定怎么报错。 */
export function assertAcpEnFixtureComplete(
  fixture: AcpEnFixture,
  dataset: Dataset,
): string[] {
  const missing: string[] = [];
  for (const t of dataset.turns) {
    if (!fixture.records[t.id]) missing.push(`记录 ${t.id}（scope=${t.scope}）缺英文派生值`);
  }
  for (const q of dataset.queries) {
    if (!fixture.queries[q.id]) missing.push(`query ${q.id}（kind=${q.kind}）缺英文形式`);
  }
  return missing;
}
