/**
 * 候选编码器加载器（阶段 1a 选型实验用）。
 *
 * 阶段 1a 的要求是"选型本身是一次实验，不改任何产品代码"。所以候选模型只在
 * probe 里加载，`src/embedding.ts` 一行不动。
 *
 * 但这带来一个必须证明的风险：probe 自建的 pipeline 如果 dtype、pooling 或
 * normalize 与生产不一致，那它测的就不是生产会得到的向量，却会把差异记成候选
 * 的成绩。两道防线：
 *
 *   1. 生产模型路径与 dtype 从 `src/embedding.ts` **导入**，不在这里重写。
 *   2. `--model` 缺省时走的就是生产模型，其读数必须**逐位复现** phase0 基线
 *      （tuned MRR 0.529 / median 2 / p90 16 / Top-5 12）。复现不了就说明这个
 *      加载器与生产不等价，任何候选对比都不成立。
 *
 * E5 家族的前缀协议（`query: ` / `passage: `）在这里是**显式参数**，不是内置
 * 规则。它的失效是静默的——能跑、有分数、就是不准——所以"这次运行加没加前缀"
 * 必须出现在报告里，而不是藏在一张模型名到前缀的映射表里。
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { join } from 'path';
import { MODEL_LOCAL_PATH, MODEL_DTYPE } from '../src/embedding';

/** 候选模型的下载缓存。放在仓库外，避免 118MB 的产物混进工作区。 */
export const CANDIDATE_CACHE_DIR =
  process.env.KIRO_MEM_BENCH_MODEL_CACHE ||
  join(process.env.HOME || '/tmp', '.cache', 'kiro-mem-bench-models');

export interface EncoderSpec {
  /** 本地目录或 HuggingFace 仓库 id。 */
  model: string;
  /** 报告里显示的名字。 */
  label: string;
  /** 查询侧前缀（E5 家族用 `query: `）。 */
  queryPrefix: string;
  /** 文档侧前缀（E5 家族用 `passage: `）。 */
  docPrefix: string;
}

export interface Encoder {
  spec: EncoderSpec;
  /** 实测输出维度，不信任配置文件里写的数。 */
  dimensions: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocument(text: string): Promise<Float32Array>;
}

/** 生产编码器的 spec：`--model` 缺省时用它，同时作为等价性自检的基准。 */
export function productionSpec(): EncoderSpec {
  return {
    model: MODEL_LOCAL_PATH,
    label: 'all-MiniLM-L6-v2（生产基线）',
    queryPrefix: '',
    docPrefix: '',
  };
}

function isLocalPath(model: string): boolean {
  return model.startsWith('/') || model.startsWith('.');
}

export async function loadEncoder(spec: EncoderSpec): Promise<Encoder> {
  const local = isLocalPath(spec.model);
  if (!local) {
    env.cacheDir = CANDIDATE_CACHE_DIR;
    env.allowRemoteModels = true;
  }

  const ext: FeatureExtractionPipeline = await pipeline('feature-extraction', spec.model, {
    // 与生产同一个精度。写死 'q8' 会在生产改精度时静默分叉。
    dtype: MODEL_DTYPE,
    ...(local ? { local_files_only: true } : {}),
  });

  const run = async (text: string): Promise<Float32Array> => {
    // pooling / normalize 必须与 `src/embedding.ts` 的 generateEmbedding 一致。
    const out = await ext(text, { pooling: 'mean', normalize: true });
    return new Float32Array(out.data as Float64Array);
  };

  const probeVec = await run('dimension probe');
  return {
    spec,
    dimensions: probeVec.length,
    embedQuery: (t) => run(spec.queryPrefix + t),
    embedDocument: (t) => run(spec.docPrefix + t),
  };
}

/**
 * 从命令行参数解析候选 spec。`--model` 缺省即生产模型。
 *
 * 前缀不做任何按模型名的推断：E5 忘加前缀是静默失效，让它显式出现在命令行与
 * 报告里，比让脚本"贴心地"替用户补上更安全。
 */
export function specFromArgs(flag: (name: string, fallback?: string) => string | undefined): EncoderSpec {
  const model = flag('model');
  if (!model) return productionSpec();
  return {
    model,
    label: flag('label', model)!,
    queryPrefix: flag('query-prefix', '')!,
    docPrefix: flag('doc-prefix', '')!,
  };
}
