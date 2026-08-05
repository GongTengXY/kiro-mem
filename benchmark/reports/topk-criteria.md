# 流式打分与有界 Top-K 轮次判据（预登记，冻结于任何实现与测量之前）

> 版本 A0。冻结时间与正文哈希见 §10。
>
> 上游：候选池策略轮次**验收通过（B-2）**，生产 `semanticCandidatePool = 20000`
> （`benchmark/reports/pool-policy-submission.md`）。同批裁定的顺序是：
> **先做本轮，再进入 Phase 3C 放宽时间窗**。
>
> 方案依据：`plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §11 与 §13.2。

---

## 1. 本轮要解决的问题

候选池轮次已经把瓶颈定位清楚，并且**不是延迟**：

| 50,000 条真实向量分布，双进程口径 | p95 | 循环内 RSS 增量 |
| --- | ---: | ---: |
| `pool=Infinity` | 277.35ms（预算 300ms 内） | **+720MB（预算 512MB，超）** |
| `pool=20000`（已发布） | 183.39ms | +461 / 466 / 465MB（三次） |

`Infinity` 在质量上是更好的答案（那 72 条零关键词 query 触达 0/72 → 43/72，整体 hit@5
36.8% → 65.8%，零 gold 退化），只因内存被否。机制已实测清楚：当前实现**先取回全部候选
blob、再逐条转 `Float32Array`、再把过 floor 的候选聚合成数组排序**。50,000 条时仅向量本体
就是 50,000 × 384 × 4B ≈ 77MB，加上行对象与平均 4,618 / 最坏 14,830 条过 floor 候选的
打分数组，稳态工作集落在 657–825MB。

分块 fetch 不解决它（候选池轮次已按裁定回滚）：拆 SQL 只降低绑定参数数量，**聚合仍在内存里**。

本轮要把 `O(候选数)` 的内存降成 `O(块大小 + K)`：

```text
按块取候选 id → 取该块 blob → 立即打分 → 只保留有界 Top-K → 丢弃该块
```

---

## 2. 明确的非目标（禁止项）

任一项发生即判本轮污染：

1. 修改 `semanticFloor` / `semanticOnlyLimit` / `rrfK` / 两路权重 / `tieBreak` / `semanticDiscovery`
   / 5 个 bigram 字段；
2. 引入 ANN、向量数据库或 SQLite 向量扩展；
3. 修改 embedding 模型、`semantic-en-v1` 协议、FTS tokenizer、内部 FTS limit 50、MCP schema；
4. 修改 90 天默认时间窗（3C 的范围）；
5. **在同一步里既换机制又改 `semanticCandidatePool` 默认值**。机制与产品值必须分成
   §5 / §6 两个阶段，否则"结果变了"无法归因到哪一个；
6. 用"内存降下来了"替代结果一致性证据。

---

## 3. 目标实现规格

### 3.1 语义腿的候选与名次语义必须与今天完全一致

今天的语义腿：

```text
candidateIds = FTS 命中 ∪ bigram 命中 ∪ 最近 N 条
→ 取这些 id 的向量（同一空间键）
→ score = cosine(query, vec)，保留 score > floor
→ 按 score 降序，名次 = 该序列中的位置（1-based）
```

流式实现必须产出**同一个** `semanticRank` / `semanticScore` 映射的可观测等价物。两处细节
必须在实现前写死，因为它们决定"等价"是否成立：

1. **FTS 命中的候选永远保留**，即使它的分数排不进 Top-K。理由：`match_source` 的
   `hybrid` 判定依赖"既有词面又有语义"，丢掉一条 FTS 命中的语义分会把它降级成 `fts`，
   那是结果改变而不是内存优化。
2. **被保留但排在 K 名之后的候选，其名次必须是真实全局名次**，不能用 `K+1` 顶替。
   做法：流式过程中为这些"额外保留项"各维护一个"比我分高的条数"计数器。FTS 命中 ≤50 条
   （内部 limit），所以计数器数量有硬上界，代价可忽略。

### 3.2 有界 Top-K 的 K

K 是本轮的自变量之一，**不预设最优值**。候选集合在 §6.2 给出，选择规则在 §6.3。

登记一条先验事实以便复核判断力：RRF 里语义名次 5,000 的贡献是 `1/(60+5000) ≈ 0.0002`，
而 FTS 名次 1 是 `1/61 ≈ 0.016`，差 80 倍。所以深处名次对页面**几乎**无影响——但"几乎"
不是"没有"，精确平局与近平局仍可能被它翻动，因此 K 必须靠**逐 query 结果一致性**选，
不能靠这个量级论证直接拍定。

### 3.3 块大小

块大小是实现常数而非策略字段，必须满足：

- 单块绑定参数数远低于 65,535（候选池轮次实测的 SQLite uint16 天花板）；
- 单块的向量本体内存 = 块大小 × 384 × 4B，登记在报告里；
- 块大小改变**不得**改变任何返回结果（§5 的一致性门覆盖它）。

---

## 4. 装置与数据纪律

全部复用已冻结装置，本轮**不新建语料**：

| 装置 | 用途 |
| --- | --- |
| 30 条 gold 语料（239 query） | 结果一致性主门（§5） |
| 2,000 条 recall-scale（3B 冻结，276 query） | 结果一致性 + 误召回不变量 |
| `pool-policy-filler-10k`（10,000 条真实向量，sha16 `bbb3a6739cd4bed8`） | 50,000 档回放的向量来源 |
| performance-scale 10,000 / 50,000 | 延迟与内存 |
| Codex 2B 盲审集 | 冻结后确认 |

纪律：

- 本轮**没有选参的"质量"环节**——K 与块大小按"结果是否逐位一致"选，不按 hit@5 选。
  因此不存在偷看确认集调参的空间，但仍不得用 heldout / validation 的指标去挑 K；
- 内存与延迟一律沿用候选池轮次的**双进程口径**（播种进程与检索进程分离，每池一个进程）；
- 每（规模 × 配置）≥ 200 个丢首轮后样本。

---

## 5. 阶段一：机制替换必须行为中立（`pool=20000` 不动）

### 5.1 门槛

| # | 门槛 | 阈值 |
| --- | --- | --- |
| T1 | 30 条 gold 语料 239 条 query 的**有序 `resultIds`** 与冻结基线 | **逐位相同**，差异 0 |
| T2 | 30 条语料全部 summary 指标与 17 个 gate | 完全一致 |
| T3 | 2,000 条装置 276 条 query 的有序 `resultIds` | 与当前实现**逐位相同**，差异 0 |
| T4 | `semanticRank` / `semanticScore` 映射 | 对上述全部 query 逐键相同（含"额外保留项"的真实名次） |
| T5 | `comparableVectors` 计数 | 逐 query 相同 |
| T6 | 跨 scope 泄漏 / 协议混排 / `semanticOnlyMax` | 0 / 0 / ≤2 |
| T7 | `bun test` + `bun run typecheck` | 全通过 / 干净 |
| T8 | 50,000 档（`pool=20000`）延迟与内存 | 不比已发布读数更差：p95 ≤ 183.39ms × 1.15，循环内 RSS 增量 ≤ 466MB |

T1–T5 是**硬性逐位一致**，不接受"差异很小"。理由：阶段一只换执行方式，任何结果差异都说明
§3.1 的名次语义没有真正等价。

T8 给 15% 的延迟宽容度，因为流式实现会多做几次 SQL 往返；内存取三次复现里的最大值作上界。

### 5.2 阶段一的失败分支

T1–T7 任一失败 → 修实现，不修门槛。若最终无法做到逐位一致，本轮结论是
「有界 Top-K 与当前名次语义不可等价」，必须写出**具体哪一条语义无法保留**，而不是放宽门槛。

---

## 6. 阶段二：在流式实现上重新评估 `pool=Infinity`

阶段一通过后才允许进入。

### 6.1 唯一产品改动

`DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool`: `20000` → `Number.POSITIVE_INFINITY`。

### 6.2 arm 矩阵

在 50,000 档（真实向量分布回放）上跑 `pool=Infinity` × K：

```text
K ∈ {200, 1000, 5000, 20000}
```

K 的来源与目的先写明（§4 纪律）：200 是"只保留一页需要的量级"的下界探针；20000 是与已发布
池值同量级的上界；1000 / 5000 填中间。**不是**为了找最优 K，而是为了找**最小的、结果仍逐位
一致的** K——K 越小内存越省。

另加两个对照：

- `full-scoring`（当前实现，pool=Infinity）：一致性比较的基准；
- `pool=20000 / K=已选`（阶段一结果）：连续性锁。

### 6.3 门槛与选择规则（先写死）

一个 (K) 只有全部满足才可行：

| # | 门槛 | 阈值 |
| --- | --- | --- |
| S1 | 与 `full-scoring`（pool=Infinity）逐 query 有序 `resultIds` | **逐位相同** |
| S2 | 完整 search p95 @50,000 | < 300ms |
| S3 | 完整 search p99 @50,000 | < 500ms |
| S4 | 检索进程循环内 RSS 增量 @50,000 | **≤ 512MB** |
| S5 | 检索进程绝对峰值 RSS @50,000 | ≤ 1024MB |
| S6 | 样本数 | ≥ 200 |
| S7 | degrade | 0 |
| S8 | 30 条语料与 2,000 条装置 | 仍满足 T1–T6 |

选择规则：在可行 K 中**取最小者**（内存最省）。若两个 K 的 RSS 差在 3 次复现的方差内
（候选池轮次实测该指标跨度约 5MB），仍取更小的 K。

### 6.4 分支（先写死）

- **存在可行 K** → 生产默认改为 `Infinity`，并且：
  - 召回收益直接引用候选池轮次 §3 的读数（同一策略、同一装置，无需重测）；
  - 必须请 Codex 针对**最终策略（`Infinity` + 选定 K）**重新构造并冻结盲审集，
    复算 G5′ / G6′ / G7 / G8 / G10——`Infinity` 是新的产品行为，不能沿用 `20000` 的盲审结论；
  - README / 策略注释里"20,000 不等价于全 scope"那段限制随之删除或改写，
    并写入新的规模上限（由 S2–S5 的实测边界给出）。
- **无可行 K**（例如 S4 仍超预算，或 S1 无法逐位一致）→ **保持 `20000`**，本阶段结论为
  未通过；如实写出是内存没降下来还是一致性做不到。这是合法结论。

---

## 7. 必须新增的测试

1. 流式实现与全量打分在**同一 fixture 上逐键相同**的 `semanticRank` / `semanticScore`；
2. FTS 命中但分数排在 K 名之后：必须仍被保留、`match_source` 仍是 `hybrid`、
   名次是真实全局名次（不是 `K+1`）；
3. 候选数恰好等于块大小 / 块大小 ±1 / 块大小整数倍：结果不变、无重复、无遗漏；
4. 候选数 < K、= K、> K 三种情形；
5. 全部候选都在 floor 之下时返回空语义腿（不是抛错）；
6. **反向测试**：把"额外保留项的真实名次"改成 `K+1`，测试 2 必须失败；把 FTS 命中的
   always-keep 去掉，测试 2 必须失败。没有反向测试的新增测试不计入交付。

---

## 8. 交付物

1. 本判据（A0 冻结）；
2. `benchmark/reports/topk-phase1-identity.{md,json}`：阶段一逐位一致证据；
3. `benchmark/reports/topk-phase2-matrix.{md,json}`：K 矩阵全表，含失败 K 与失败原因；
4. `benchmark/reports/topk-selection.json`：确定性选择脚本输出，禁止手工抄表；
5. 三次复现的内存/延迟读数（P3 类指标是 GC 驱动的，单次不作结论）；
6. `benchmark/reports/topk-submission.md`（按方案 §15 模板）；
7. 测试清单与反向测试实测输出。

---

## 9. 先写下来的已知限制

1. **50,000 档的文本仍是 10,000 条重复 5 份**（候选池轮次裁定允许）。cosine 分布逐位保留，
   但 FTS 侧命中形状与 50,000 条各自独立的语料不同。
2. **RSS 是 GC 驱动的读数**，跨运行有方差；本轮一律取 3 次复现，报告写出跨度。
3. **逐位一致只能在已冻结装置上验证**。装置外的 query 分布可能触发未覆盖的近平局形状，
   §6.4 因此要求 Codex 对最终策略重建盲审集。
4. **本轮不改善召回**。阶段二若通过，收益来自把池放回全 scope，而那份收益的证据是
   候选池轮次的，不是本轮的。
5. **块大小与 K 的最优值依赖机器**（内存带宽、GC 行为）。本轮选的是"在本机可行且最小"，
   不声称跨机器最优。

---

## 10. Provenance

| 项 | 值 |
| --- | --- |
| 判据文件 | 本文件 |
| 冻结口径 | SHA-256 前 16 位，取**本表 checksum / 时间两行填入之前**的正文 |
| 冻结时点 | **先于任何实现改动与任何测量** |
| 上游策略 | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / **pool=20000** / bigramAux=false |
| 复用装置 | 30 条 gold；2,000 条 recall-scale（filler `10b572bd3ec7e4b9`）；`pool-policy-filler-10k`（`bbb3a6739cd4bed8`）；performance-scale 10k/50k |
| A0 checksum | `699d988c419be7b3` |
| A0 冻结时间 | `2026-08-05T11:12:03Z` |

复现命令（本判据冻结时尚未运行任何一条）：

```bash
# 阶段一：行为中立（pool=20000 不动）
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --fusion --empty-ext \
  --no-heldout --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 \
  --fts-weight=1 --semantic-weight=1 --tie-break=semantic-rank --semantic-candidate-pool=20000 \
  --bigram-aux=off --json=benchmark/reports/topk-phase1-identity.json
bun run benchmark/run-phase3b-scale.ts --pools=20000 --sizes=0 \
  --json=benchmark/reports/pool-policy/recall-topk.json

# 阶段一 T8 + 阶段二：50,000 档（双进程，每配置 3 次）
bun run benchmark/run-pool-perf-recheck.ts --phase=seed    --size=50000 --db=/tmp/topk-50k.db
bun run benchmark/run-pool-perf-recheck.ts --phase=measure --size=50000 --db=/tmp/topk-50k.db \
  --pools=20000,full --rounds=11

# 选择
bun run benchmark/select-topk.ts
```
