# 阶段 1b：产品形态验证（all-MiniLM + semantic-en-v1）

> 日期：2026-07-30
> 依据：`plan/V3/retrieval-optimization-plan-2026-07-29.md` v7 的 §5.3–§5.6、§11
> 压缩器：`gold`（把人工标注逐字搬进 Observation），**唯一自变量 = `--protocol`**
> 落盘报告：`gold-phase1b-raw.md` / `gold-phase1b-semantic-en.md` /
> `gold-phase1b-{raw,semantic-en}-validation.md` /
> `probe-semantic-rank-phase1b-{raw,semantic-en}.md`

## 0. 一句话结论

`semantic-en-v1` 通过了 §5.5 的全部质量、协议、热路径、失败、轻量与并发门槛：
**heldout hit@5 44.4% → 50.0%（= 词汇锚点门未拆时的理论上限）、tuned MRR 0.769 → 0.833、
退化 0 条、expected-empty 仍 0.00/0**；新增未查看验证集 70% → 75%（同样打满该集的结构上限）。
产品形态上：默认查询路径**不新增第二次 LLM 往返**，同一 dataDir 实测**只有 1 个模型实例**，
产品路径 p95 **22.3ms**。

按 v7 §5.8 的止损条款，没有任何硬门槛失败，因此**不启用 e5-small 备选**。

## 1. 实现形态（改了什么）

| 位置 | 改动 | 为什么必须这样 |
| --- | --- | --- |
| `src/semantic-en.ts` | 协议常量、`embeddingSpaceKey()`、记录侧/查询侧护栏 | 版本键必须含协议：`raw-v1` 与 `semantic-en-v1` 同为 384 维同模型，只比模型名会静默混排 |
| `src/embedding-space.ts` | 从 `embedding.ts` 拆出空间常量与纯函数（无 transformers） | 实测：仅 import transformers 就 +54MB RSS / +128ms，每个 kiro-cli 会话付一次 |
| `src/db/schema.ts` | `observation_embeddings` 主键 → `(observation_id, model)`；新表 `observation_semantic_texts`；`migrateSchema()` | 单列主键会让两个协议互相覆盖；派生值有生命周期与 provenance，不能塞进不可变的 `observations` |
| `src/acp/compressor.ts` | 压缩 prompt 内产出 `semantic_en`；另有翻译专用 prompt 作第二次尝试 | §5.4 第 1 条：记录侧不为每条 observation 再发一次翻译调用 |
| `src/server/worker.ts` | `resolveSemanticEn()` 两次尝试 → ready/failed/pending；`embed_observation` 按协议各写一条向量并在落库前再过一次护栏；新增有界 `POST /embed/query` | 错译比缺译更坏（读时无法区分）；查询向量集中到 Worker 才有"单模型实例" |
| `src/server/observation-search.ts` | `opts.semanticQueryEn` → 协议与空间键**单点决定** | 让"query 文本来自一个协议、空间键来自另一个协议"在代码里不可表达 |
| `src/server/mcp-server.ts` | `search` 新增 `semantic_query_en`；改用 Worker 取查询向量；删掉本进程模型预热 | 英文形式由已在推理中的 Agent 随参数给出 = 0 次额外 LLM 往返 |
| `src/worker-embedder.ts` | MCP 侧的 HTTP 取向量客户端 | 任何失败（Worker 挂、429、超时、长度不符）都抛错 → 检索层降级为 FTS-only |

## 2. §5.5 质量门槛（阈值在 phase 0 之后写死，未事后调整）

| 项 | 门槛 | arm A（raw） | arm B（semantic-en） | 结果 |
| --- | --- | ---: | ---: | :--: |
| 离线语义 MRR（tuned 18 条） | ≥ 0.609 | 0.529 | **0.972** | ✅ |
| 离线名次中位数（tuned） | = 1 | 2 | **1** | ✅ |
| 离线 p90 名次（tuned） | ≤ 8 | 16 | **1** | ✅ |
| 改善 query 数 | ≥ 6 | — | **10** | ✅ |
| 退化 query 数 / 单条最大退化 | ≤ 4 / ≤ 5 位 | — | **0 / 0** | ✅ |
| 离线语义 MRR（heldout，确认集） | ≥ 0.365（不下降） | 0.365 | **0.833** | ✅ |
| heldout hit@5（端到端） | ≥ 44.4% | 44.4% | **50.0%** | ✅ |
| heldout MRR（端到端） | 上升 | 0.403 | **0.417** | ✅ |
| tuned hit@5（连续性锁） | ≥ 90% | 94.4% | 94.4% | ✅ |
| tuned MRR（端到端，不回退） | ≥ 0.769 | 0.769 | **0.833** | ✅ |
| tuned R-precision | ≥ 55% | 61.1% | **77.8%** | ✅ |
| expected-empty 平均 / 最坏 | 0 / 0 | 0.00 / 0 | **0.00 / 0** | ✅ |
| 跨 workspace 泄漏 | 0 | 0 | **0** | ✅ |

**heldout 50.0% 就是上限，不是"还差一半"。** 词汇锚点门在语义步骤之前，9 条零锚点
heldout query 在任何编码器/协议下都返回空；理论上限 9/18 = 50%，arm B 正好打满。
达到它的机制与 v6 的预测逐字吻合：**q38 的语义名次 11 → 1**，于是它第一次进了结果页。

离线读数（`probe-semantic-rank-phase1b-*.md`）：raw 0.529 / median 2 / p90 16 / top5 12/18，
**逐位复现 phase 0 基线**——这同时证明探针的加载器与生产等价；semantic-en 0.972 / 1 / 1 / 18/18。

一处**副作用**值得记下：`semanticOnlyTotal` 164 → 80。未经词面验证的 semantic-only 结果
少了一半，因为英文空间里真正相关的记录挤掉了原先靠"中文向量都挤在退化区域"混进来的
噪声。这对 §6.3 的限额设计是好消息，但它是观察，不是本阶段的门槛。

## 3. §5.5 产品门槛

| 门槛 | 要求 | 实测 | 证据 |
| --- | --- | --- | --- |
| 协议：非法/缺失派生值进入 `semantic-en-v1` 向量表 | 0 条 | **0**（向量数 30 == ready 30） | benchmark 结构门槛 + `semantic-en-record.test.ts` |
| 协议：跨协议 cosine 比较 | 0 次 | **0**（读取按完整空间键过滤） | `semantic-en-search.test.ts`：英文 query 只打分 en 向量，无英文只打分 raw |
| 热路径：默认 search 新增 LLM 往返 | 0 次 | **0** | `semantic-en-record.test.ts` 断言合法派生值时翻译 prompt 调用数为 0；查询侧英文形式来自入参 |
| 热路径：search p95（已提供合法英文形式） | < 300ms | **22.3ms**（p50 19.9 / max 35.3，n=40 热态，真实模型 + Worker HTTP） | 临时延迟探针；benchmark 内进程读数 13.9ms |
| 失败：记录侧重试耗尽 | 保留原记录、标记待补、不写错误英文向量 | ✅ | 两次被拒 → `failed` + 只有 raw 向量 + 原文完好 |
| 失败：query 侧缺失/校验失败 | 走 FTS 或独立 raw 腿，不整体报错 | ✅ | `...` 与中文回显被拒后落回 raw-v1；Worker 挂掉 → FTS-only |
| 轻量：包内模型 | 仍为 all-MiniLM ~23MB，不引入 e5 | **23M，`models/` 仅一个目录**；npm pack 16.1MB / 解包 24.0MB | `du` + `npm pack --dry-run` |
| 轻量：同一 dataDir 模型初始化次数 | 1 | **1** | `/health.embedding_runtime.model_instances`；3 repo 并发实测 ≤ 1 |
| 并发：3 repo 同时检索 | 无跨 scope 泄漏、无永久占队 | ✅ | 真实 HTTP 三路并发各只返回自己 scope；队列到上限后 429 而非排队 |
| 端到端：A/B 各跑一次完整 benchmark | 必须 | ✅ | 本报告第 2 节 |

## 4. 新增未查看验证集（§5.6，只读一次）

`benchmark/dataset/queries-validation.json`：20 条（中文 10 / 英文 10），实现冻结后才写，
未参与协议选择、prompt 调整、护栏规则或 floor 取值；`--validation` 显式开关，默认不加载。

| 子集 | 条数 | arm A hit@5 | arm B hit@5 | arm A MRR | arm B MRR |
| --- | --- | ---: | ---: | ---: | ---: |
| 全部 | 20 | 70.0% | **75.0%** | 0.625 | **0.667** |
| 中文 | 10 | 40.0% | **50.0%** | 0.300 | **0.433** |
| 英文 | 10 | 100.0% | 100.0% | 0.950 | 0.900 |

R-precision 55.0% → 60.0%。**5 条零锚点**（FTS 候选为 0）在两个 arm 下都返回空，
所以这一集在门未拆时的上限是 15/20 = 75.0%——**arm B 正好打满**。

两个必须一起读的事实：

- **中文半是收益来源**（+10pp hit@5、+0.133 MRR），与病因判断一致：中文原文进 MiniLM 才是问题。
- **英文半唯一一处退化**：v13 最终名次 1 → 2（MRR 0.95 → 0.90）。这与 1a 的对照实验一致——
  基线在 en→en 上本来就是四个候选里最好的（离线 0.972），所以英文 query 在 arm B 没有可赚的
  空间，只剩 churn。它没有丢任何命中，但不能被均值吸收掉。

**诚实边界（必须随读数一起引用）**：这批 query 由实现者本人依据 `turns.json` 标注写成，
写的时候已经看过 tuned / heldout 的结果，所以它弱于独立第三方标注。它唯一强的地方是：
这些具体问法从未参与任何选择，且只读了一次，没有据此回调任何参数。

## 5. ACP 运行可靠性（§9 纪律 10：必须单独报，不能与质量混算）

固定输入用于 A/B 是为了让唯一自变量是协议；运行可靠性则必须用 fresh ACP 单独测量。
本轮生成 20 条验证集英文形式的实测：

| 项 | 值 |
| --- | --- |
| 首轮成功 | **11 / 20（55%）** |
| 首轮失败构成 | ACP `initialize` 超时 4 条；JSON 解析失败 4 条；schema 不符 1 条 |
| 定向重试（concurrency=2，timeout 45s） | **9 / 9 成功** |

一处新发现：**失败集中在本来就是英文的 query 上**（v17–v20）。"中文→英文"的翻译 prompt
喂进一句已经是英文的话时，模型更容易回一句解释而不是 JSON。这是 probe 侧现象——生产里
英文形式由发起 search 的 Agent 直接给出，不走这个 prompt；但它同时说明记录侧 prompt 里
"原文本来就是英文时照抄即可"那条规则不是多余的。

另有一处一次性成本：4 条 `scope: other` 记录与 leakage query q20 此前没有英文固定输入
（1a 只译进池的 26 条）。补齐它们不是锦上添花：否则"跨 scope 无泄漏"可能只是因为那 4 条
压根没有英文向量，那条证据就是假的。补齐后 30 条记录 / 42 条 query 全部通过生产护栏，
**0 条被拒**——说明护栏没有在拒绝合法的 ACP 输出。

## 6. 缺口与未验证事项（登记，不掩盖）

| 项 | 状态 |
| --- | --- |
| 派生值的**重建**路径 | 未实现。`kiro-mem repair` 只补 raw-v1（本地可重算）。协议或译者升级后，已有 observation 的 `semantic-en-v1` 派生值没有批量重建入口；表里有 `translator` / `attempts` / `failure_reason` 支撑它，作业本身要单独做 |
| `pending` 的自动重试 | 未实现。记录侧两次尝试都在 `summarize_turn` 内，耗尽即落 `pending`/`failed`，之后没有队列去重试它 |
| 真实 Agent 是否稳定提供 `semantic_query_en` | **未验证**。已进 MCP schema 与 `prompt.md`，但"Agent 实际调用时给不给、给得对不对"只能在真实会话里观察；给不出时的行为已实测（落回 raw-v1，不报错） |
| ACP 压缩 prompt 变长对摘要质量的影响 | **已测，无退化**（`phase1b-acp-verification.md`）：3 轮实测事实召回均值 0.948（旧 min 0.9167）、文件召回 100%、fallback 0、JSON repair 0；派生值 30/30 ready ×3。同时发现一处既有缺陷（RRF 平局按时间打破）与一处阈值分辨力问题，均已登记给阶段 2 |
| 升级路径 | 旧库里 `model = 'all-MiniLM-L6-v2'` 的向量行在新空间键下不可读（保留未删），coverage 会掉到 0 直到 `kiro-mem repair` 重建 raw-v1。这是刻意的：混排比"暂时只有关键词可达"更坏 |
| expected-empty 的验证地位 | 结构性缺口不变：5 条 empty 既是唯一真负例来源又必须用于校准，永远是校准指标 |
| 英文 query 的 churn | v13 一条名次 1 → 2。样本量不足以判断这是噪声还是系统性代价 |

## 7. 复现

```bash
# arm A（对照）
bun run benchmark/run.ts --compressor=gold --protocol=raw \
  --report=benchmark/reports/gold-phase1b-raw.md
# arm B
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en \
  --report=benchmark/reports/gold-phase1b-semantic-en.md
# 新增验证集（每个 arm 只读一次）
bun run benchmark/run.ts --compressor=gold --protocol=raw --validation \
  --report=benchmark/reports/gold-phase1b-raw-validation.md
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --validation \
  --report=benchmark/reports/gold-phase1b-semantic-en-validation.md
# 离线排名读数
bun run benchmark/probe-semantic-rank.ts --subset=tuned \
  --report=benchmark/reports/probe-semantic-rank-phase1b-raw.md
bun run benchmark/probe-semantic-rank.ts --subset=tuned --lang=en \
  --en-mirror=benchmark/dataset/mirror-en-acp-records.json,benchmark/dataset/mirror-en-acp-queries.json \
  --report=benchmark/reports/probe-semantic-rank-phase1b-semantic-en.md
# 固定输入（一次性，走真实 ACP）
bun run benchmark/probe-acp-translate.ts --target=records --record-scope=all --ids=x01,x02,x03,x04 \
  --out=benchmark/dataset/mirror-en-acp-records-other.json
bun run benchmark/probe-acp-translate.ts --target=queries --query-set=leakage \
  --out=benchmark/dataset/mirror-en-acp-queries-leakage.json
bun run benchmark/probe-acp-translate.ts --target=queries --query-set=validation \
  --out=benchmark/dataset/mirror-en-acp-queries-validation.json
```

`bun run typecheck` 干净，`bun test` **338 pass / 0 fail**（新增 41 项：协议护栏 20 /
检索协议隔离 9 / 记录侧 6 / Worker 单实例与背压 6）。

## 8. 下一步

阶段 1b 的门槛全部通过，因此 v7 §11 的下一站成立：**阶段 2（拆词汇锚点门 + 定 floor +
修 `heldoutNoAnchor` 定义 + semantic-only 限额）**。它现在有了两条 1b 才具备的输入：

1. `semantic-en-v1` 下的候选 floor（1a 离线扫描给出 0.197 / 0.223 / 0.275 三档，
   pair 级，仅候选）——阶段 2 必须逐个跑完整链路，不能用 pair 分布代替端到端验收。
2. `semanticOnlyTotal` 164 → 80 说明限额值的取舍已经变了，`min(3, limit)` 这个数要重新扫。
