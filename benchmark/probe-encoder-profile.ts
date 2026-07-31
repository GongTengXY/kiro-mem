/**
 * 编码器画像探针（阶段 1a）：体积、冷启动、延迟、内存，以及跨语言可用性。
 *
 * 与 `probe-semantic-rank.ts` 分开的理由是它回答的是**另一类**问题。排名探针测
 * "在我们的语料上排得准不准"，本脚本测的全部是**编码器自身的性质**，与我们的
 * query 集无关：
 *
 *   - 体积 / 冷启动 / RSS / 延迟 —— 决定它能不能装进产品。`npm i -g` 的体积、
 *     MCP 进程冷启动是否会撞上 1200ms 查询超时、每个 Kiro 会话各加载一份的内存，
 *     都是选型的硬约束，而不是"质量之外的次要因素"。
 *   - 跨语言可用性 —— 用**固定的、写死在脚本里的**句对测分离度。它们不取自
 *     `benchmark/dataset/`，所以这一项不消耗校准集样本，也不构成对我们语料的
 *     相关性判断。中文专用模型丢不丢英文，只能这样测：校准集里一条英文 query
 *     都没有，拿它去论证英文侧安全属于中途换层。
 *
 * 冷启动必须在**全新进程**里测，所以这件事就是本脚本存在的形式：它自己就是那个
 * 全新进程，每个候选跑一次。在跑过 30 条记录之后再读 RSS，读到的是被污染的值。
 *
 * 用法：
 *   bun run benchmark/probe-encoder-profile.ts
 *   bun run benchmark/probe-encoder-profile.ts --model=Xenova/multilingual-e5-small \
 *     --label=e5-small --query-prefix='query: ' --doc-prefix='passage: '
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadEncoder, specFromArgs, CANDIDATE_CACHE_DIR } from './encoder';
import { cosineSimilarity } from '../src/embedding';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const spec = specFromArgs(flag);
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
const reportPath = resolve(
  flag('report', join(import.meta.dir, 'reports', `probe-encoder-profile-${slug(spec.label)}.md`))!,
);
const jsonPath = flag('json') ? resolve(flag('json')!) : undefined;

// ---------------------------------------------------------------------------
// 体积
// ---------------------------------------------------------------------------

/** 运行时真正会被加载的文件。安装脚本拷的就是这几个。 */
const RUNTIME_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

/** 候选模型在缓存里的落盘目录（transformers.js 布局：<cacheDir>/<org>/<name>）。 */
function candidateDir(): string {
  if (spec.model.startsWith('/') || spec.model.startsWith('.')) return spec.model;
  return join(CANDIDATE_CACHE_DIR, spec.model);
}

function measureSize(): { runtimeBytes: number; totalBytes: number; missing: string[]; dir: string } {
  const dir = candidateDir();
  let runtimeBytes = 0;
  const missing: string[] = [];
  for (const f of RUNTIME_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) runtimeBytes += statSync(p).size;
    else missing.push(f);
  }
  return { runtimeBytes, totalBytes: dirBytes(dir), missing, dir };
}

// ---------------------------------------------------------------------------
// 冷启动 / 延迟 / 内存
// ---------------------------------------------------------------------------

const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const rssBefore = rssMb();

const tLoad0 = performance.now();
const encoder = await loadEncoder(spec);
// loadEncoder 内部已经跑过一次 dimension probe，所以这个数就是"进程启动到能算出
// 第一个向量"的墙钟时间——正是 MCP 进程会撞上 1200ms 查询超时的那段。
const coldStartMs = performance.now() - tLoad0;
const rssAfterLoad = rssMb();

const SHORT = '搜索为什么会降级成只用 FTS';
const LONG = '本轮修复了 FTS 特殊字符查询报错的问题，'.repeat(80).slice(0, 2000);

async function median(fn: () => Promise<unknown>, runs = 8): Promise<number> {
  await fn(); // warmup
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

const shortMs = await median(() => encoder.embedQuery(SHORT));
const longMs = await median(() => encoder.embedDocument(LONG));
const rssAfterWork = rssMb();

// ---------------------------------------------------------------------------
// 跨语言可用性（固定句对，不取自数据集）
// ---------------------------------------------------------------------------
//
// 每组给一对"改写"（应该高）和一对"无关"（应该低），报**间距**。绝对分数在不同
// 模型间不可比——退化嵌入的典型特征恰恰是无关句对的分数也很高——所以判据是间距。

const PAIRS: { group: string; kind: 'paraphrase' | 'unrelated'; a: string; b: string }[] = [
  { group: '中文', kind: 'paraphrase', a: '搜索为什么会降级成只用 FTS', b: '向量算不出来的时候检索还能不能用' },
  { group: '中文', kind: 'unrelated', a: '搜索为什么会降级成只用 FTS', b: '支付回调验签对账差异排查' },
  { group: '英文', kind: 'paraphrase', a: 'why does search fall back to FTS only', b: 'what happens to retrieval when embeddings are unavailable' },
  { group: '英文', kind: 'unrelated', a: 'why does search fall back to FTS only', b: 'payment callback signature reconciliation' },
  { group: '中英混排', kind: 'paraphrase', a: 'observation-search.ts 里的 SEMANTIC_FLOOR 是怎么定的', b: 'how was the semantic floor constant calibrated in observation-search.ts' },
  { group: '中英混排', kind: 'unrelated', a: 'observation-search.ts 里的 SEMANTIC_FLOOR 是怎么定的', b: 'iOS APNs 推送证书续期流程' },
  { group: '标识符', kind: 'paraphrase', a: 'src/db/index.ts extractFtsSearchUnits trigram', b: '把 query 切成检索单元后 OR 连接的那个函数' },
  { group: '标识符', kind: 'unrelated', a: 'src/db/index.ts extractFtsSearchUnits trigram', b: 'Excel 导出中文乱码编码问题' },
];

const pairScores: { group: string; kind: string; score: number }[] = [];
for (const p of PAIRS) {
  const [va, vb] = [await encoder.embedQuery(p.a), await encoder.embedQuery(p.b)];
  pairScores.push({ group: p.group, kind: p.kind, score: cosineSimilarity(va, vb) });
}
const margins = [...new Set(PAIRS.map((p) => p.group))].map((group) => {
  const para = pairScores.find((s) => s.group === group && s.kind === 'paraphrase')!.score;
  const unrel = pairScores.find((s) => s.group === group && s.kind === 'unrelated')!.score;
  return { group, paraphrase: para, unrelated: unrel, margin: para - unrel };
});

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const size = measureSize();
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const fmt = (x: number, d = 3) => x.toFixed(d);

const lines: string[] = [];
lines.push(`# 编码器画像：${spec.label}`);
lines.push('');
lines.push('测的是编码器**自身**的性质，与我们的 query 集无关。跨语言那一节用的是写死在');
lines.push('脚本里的固定句对，不取自 `benchmark/dataset/`，因此不消耗校准集样本。');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
lines.push(`| 命令行 | \`bun run benchmark/probe-encoder-profile.ts ${args.join(' ')}\` |`);
lines.push(`| 模型 | \`${spec.model}\` |`);
lines.push(`| 实测输出维度 | ${encoder.dimensions} |`);
lines.push(`| 前缀协议 | query=${spec.queryPrefix ? `\`${spec.queryPrefix}\`` : '无'} / doc=${spec.docPrefix ? `\`${spec.docPrefix}\`` : '无'} |`);
lines.push(`| 运行环境 | Bun ${Bun.version} / ${process.platform} ${process.arch} |`);
lines.push('');
lines.push('## 体积 / 冷启动 / 内存 / 延迟');
lines.push('');
lines.push('| 指标 | 值 | 说明 |');
lines.push('| --- | --- | --- |');
lines.push(`| 运行所需文件之和 | **${mb(size.runtimeBytes)}** | 会被打进 npm tarball 的那部分${size.missing.length ? `（缺 ${size.missing.join(', ')}）` : ''} |`);
lines.push(`| 落盘目录总体积 | ${mb(size.totalBytes)} | 含其它精度/额外文件，不进包 |`);
lines.push(`| 冷启动到首个向量 | **${fmt(coldStartMs, 0)}ms** | MCP 进程会话首次 search 撞的就是这段（查询超时 1200ms） |`);
lines.push(`| 短查询延迟（中位数，8 次） | ${fmt(shortMs, 1)}ms | |`);
lines.push(`| 长文本延迟（2000 字，中位数，8 次） | ${fmt(longMs, 1)}ms | \`embed_observation\` job 的量级 |`);
lines.push(`| RSS：加载前 / 加载后 / 跑完 | ${rssBefore} / **${rssAfterLoad}** / ${rssAfterWork} MB | Worker 常驻一份，**每个 Kiro 会话的 MCP 进程各一份** |`);
lines.push('');
lines.push('## 跨语言方向性自检（固定句对，**不可横向比较**）');
lines.push('');
lines.push('这一节只回答一个**模型内部**的是非题：在这门语言上，改写对的分数有没有高于');
lines.push('无关对？间距为负或约等于 0，说明该语言下的相似度连方向都不对。');
lines.push('');
lines.push('**绝对间距不能用来在候选之间排序。** 句向量模型的各向异性差别很大：E5 家族的');
lines.push('全部 cosine 会挤在一个窄高带里，间距 0.06 可能已经足够把顺序分开；而另一个模型');
lines.push('间距 0.30 也可能只是分布更宽。横向可比的分离度读数在');
lines.push('`probe-similarity-dist.ts` 的 AUC（标度无关），不在这里。');
lines.push('');
lines.push('| 语言组 | 改写对 | 无关对 | 间距（仅看正负与量级） |');
lines.push('| --- | --- | --- | --- |');
for (const m of margins) {
  const verdict = m.margin <= 0 ? ' ❌ 方向错' : m.margin < 0.02 ? ' ⚠️ 近乎无方向' : '';
  lines.push(`| ${m.group} | ${fmt(m.paraphrase)} | ${fmt(m.unrelated)} | ${fmt(m.margin)}${verdict} |`);
}
lines.push('');

mkdirSync(join(import.meta.dir, 'reports'), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf-8');
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        spec,
        dimensions: encoder.dimensions,
        size: { runtimeBytes: size.runtimeBytes, totalBytes: size.totalBytes, missing: size.missing },
        coldStartMs,
        shortMs,
        longMs,
        rss: { before: rssBefore, afterLoad: rssAfterLoad, afterWork: rssAfterWork },
        margins,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

console.log('');
console.log(
  `  ${spec.label}  dims=${encoder.dimensions}  运行文件=${mb(size.runtimeBytes)}  ` +
    `冷启动=${fmt(coldStartMs, 0)}ms  短=${fmt(shortMs, 1)}ms  长=${fmt(longMs, 1)}ms  ` +
    `RSS=${rssAfterLoad}MB`,
);
console.log(`  间距： ${margins.map((m) => `${m.group} ${fmt(m.margin)}`).join('  ')}`);
console.log(`[probe] 报告已写入 ${reportPath}`);
