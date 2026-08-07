# Top-K 轮次提交：流式打分 + 有界 Top-K，候选池放回全 scope —— **通过**

> ## 状态：**已通过 Codex 独立盲审**（`topk/codex-blind-audit.md`，PASS）
>
> 本文件是判据 §8 第 6 项的交付物，**在盲审通过之后补交**。它只汇总已冻结的产物，
> **没有重跑任何 arm，没有改动任何历史指标**，也不改变已验收的结论。
>
> 判据：`benchmark/reports/topk-criteria.md`，A0 `699d988c419be7b3`（冻结于任何实现与测量
> 之前），B1 `2285d0fa8cf5e1ee`（§6.3 聚合口径修订，**晚于**看到 50,000 档读数，由裁定作出，
> 预登记强度低于 A0，已在判据与本文件如实披露）。

---

## 阶段

Top-K 轮次（方案 §11 / §13.2 的落地）。上游：候选池轮次验收通过（B-2，`pool=20000`），
同批裁定的顺序是**先做本轮，再进入 Phase 3C**。

两个阶段严格分开，这是判据 §2 第 5 条的禁止项：

- **阶段一**：只换执行机制（分块取候选 → 立即打分 → 有界保留），`semanticCandidatePool`
  保持 20000，`semanticTopK` 默认 `Infinity`（= 不截断 = 换之前的行为）。必须行为中立。
- **阶段二**：唯一产品改动 `semanticCandidatePool` 20000 → `Infinity`，并选定有限 K。

---

## 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/server/observation-search.ts` | 新增 `streamScoreCandidates()`；`RetrievalPolicy` 新增 `semanticTopK`；新增值域校验；`onCandidates` 新增 `aboveFloorCount`；语义腿改为调用流式打分。**阶段二**：`semanticCandidatePool` → `Number.POSITIVE_INFINITY`，`semanticTopK` → `1000` |
| `tests/integration/retrieval-policy.test.ts` | 等价性测试（含真实分块边界 4095/4096/4097/8192）+ 两个冻结 profile 锁补字段 |
| `benchmark/run-codex-phase2b-audit.ts`、`run.ts`、三个 grid 驱动 | 补登记 `semanticTopK`；grid 驱动加显式例外守卫（历史读数在不截断下测的） |
| `benchmark/select-topk.ts`、`run-codex-topk-audit.ts` | 新增：确定性选择脚本、Codex 盲审 runner |
| `README.md` / `docs/i18n/README.zh.md` | 改写"20,000 不等价于全 scope"那条限制为"只有前 1,000 条语义候选保留名次"，写入新的规模上限 |

### 明确未改

`semanticFloor` 0.197 / `semanticOnlyLimit` 2 / `rrfK` 60 / 权重 1:1 / `tieBreak` semantic-rank /
`semanticDiscovery` true / 5 个 bigram 字段（`bigramAux` 仍 `false`）/ FTS tokenizer /
内部 FTS limit 50 / embedding 模型 / `semantic-en-v1` 协议 / MCP schema / 90 天默认时间窗
（那是 3C 的范围）/ DB schema。

### 为什么这次替换可以是**可证**等价

两条性质决定一切，都写进了代码注释：

1. **访问顺序**。旧路径一次 `IN (...)` 取回全部候选，再用**稳定排序**按 score 降序排，
   所以同分时保持 SQLite 的返回顺序。实测（Bun 1.2.20 / SQLite 3.43.2）`WHERE id IN (...)`
   **无论入参顺序都按 rowid 升序返回**。流式实现把 `candidateIds` 升序排序后分块、
   比较器用 `(score desc, id asc)`，复现同一个平局次序。
2. **名次语义**。FTS / bigram 命中的候选**永远保留**（丢掉会把 `hybrid` 降级成 `fts`，
   那是结果改变而非内存优化）；被保留但排在 K 名之后的候选，名次是**真实全局名次**
   （靠流式过程中的"比我分高的条数"计数器，不是 `K+1`）。计数器数量有硬上界
   （FTS 内部 limit 50 + bigram cap），代价可忽略。

---

## Provenance

| 项 | 值 |
| --- | --- |
| commit | `b2e972f`（阶段一）→ `13ad15c`（阶段二），dirty |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 判据 | A0 `699d988c419be7b3`（先于实现）；B1 `2285d0fa8cf5e1ee`（后于读数，由裁定作出） |
| 起点策略 | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / **pool=20000** / bigramAux=off |
| 终点策略 | 同上，唯 **pool=Infinity + semanticTopK=1000** |
| 装置（全部复用，本轮不新建语料） | 30 条 gold（239 query）；2,000 条 recall-scale（filler `10b572bd3ec7e4b9`）；`pool-policy-filler-10k`（`bbb3a6739cd4bed8`）；performance-scale 10k/50k；Codex 2B 盲审集 |
| 块大小 | 4096（实现常数，非策略字段），向量本体每块约 6.3MB |

---

## 指标

### 1. 阶段一：行为中立（T1–T8）—— 全过

| # | 门槛 | 读数 |
| --- | --- | --- |
| T1 | 30 条 gold 239 query 有序 `resultIds` | 差异 **0** |
| T2 | 全部 summary 指标 + 17 gate | 完全一致，gate 全过 |
| T3 | 2,000 条装置 276 query 有序 `resultIds` | 差异 **0** |
| T4 | `semanticRank` / `semanticScore` 逐键 | 与**内联参考实现**逐键相同（含全同分形状与真实分块边界） |
| T5 | `comparableVectors` 逐 query | 差异 **0** |
| T6 | 泄漏 / 协议混排 / `semanticOnlyMax` | 0 / 0 / 2 |
| T7 | `bun test` / `typecheck` | **523 pass / 0 fail** / 干净 |
| T8 | 50,000 档（pool=20000）延迟与内存 | p95 139.98 / 148.32 / 204.22ms（阈值 210.9）；RSS +322 / +381 / +263MB（阈值 ≤466）——**明显更省**，流式在同池值下已降约 30% |

T4 用内联参考实现而不是录好的黄金文件：参考实现可以跑在任何 fixture 上，包括没有任何既有
benchmark 覆盖的形状（全同分 25 条、分块边界 4095/4096/4097/8192，四档共约 20,480 次逐键比较）。

如实登记一处变差：**p99 方差更大**（425.95 / 444.76 / 295.08ms，换之前 282–343ms）。
T8 不设 p99 门槛，阶段二的 S3（<500ms）正面约束它，三次都在预算内。按块取 blob 会多做几次
SQL 往返，尾部因此更抖，机制上说得通。

### 2. 阶段二：K 矩阵与选择（S1–S8）

全表见 `topk-phase2-matrix.md`。结论：

```text
K=  200  ❌ p95 181/192/372ms, p99 294/400/702ms，且 3 条 query 丢 gold 名次（确定性失败）
K= 1000  ✅ p95 158/183/193/216/286ms  p99 338/357/358/443/448ms  RSS +225…+324MB
K= 5000  ❌ p95 250/257/536ms  p99 328/538/1376ms
K=20000  ❌ p95 271/333/349ms  p99 410/449/524ms
```

**K=1000 是唯一可行 arm**，因此判据 §6.3"在可行 K 中取最小者"没有可选空间。

`semanticTopK = Infinity` 被结构性排除（判据 B1）：保留集随语料增长（50,000 档实测均 4,618 /
最坏 14,830 条），不满足 `O(块大小 + K)`。它的 RSS 实测 +338…+405MB 也系统性高于 K=1000。

结果一致性：四个 K 在 2,000 条装置（276 query）与 50,000 档（真截断，20 页）上，
有序 `resultIds` 与 full-scoring 参考**差异 0**。K=200 在 50,000 档只保留 4,618 条过 floor
候选中的 163 条，返回页仍然相同——预登记的先验（语义名次到几千位对 RRF 的贡献是 `1/(60+n)`，
配上 cap=2 进不了 10 条的页面）成立。

### 3. 召回收益（引用候选池轮次，非本轮证据）

判据 §9 第 4 条先写明：**本轮不改善召回**。阶段二通过后收益来自把池放回全 scope，
而那份收益的证据是候选池轮次的（同策略、同装置，无需重测）：

- 72 条 `ftsCount=0` 校准 query：语义腿触达 **0/72 → 43/72**，hit@5 0% → 31.9%；
- 整体语义触达 35.8% → 80.0%，hit@5 36.8% → 65.8%；
- **没有任何一条 gold 掉出 top-5 或掉出整页**。

### 4. Codex 独立盲审（针对最终策略重建）

判据 §6.4 要求：`Infinity` 是新的产品行为，不能沿用 `20000` 的盲审结论。Codex 因此针对
**最终策略（`Infinity` + K=1000）** 重新构造并冻结盲审集，26 条零 FTS relevance + 26 条
hard negative，冻结输入 SHA-256 `9048d05c57c5aa09440f17216b1fd034cbe75b478cd78c225399948f5648157c`。

| 指标 | pool=200 基线 | full-scoring 参考 | 最终（Infinity + K=1000） |
| --- | ---: | ---: | ---: |
| relevance 触达 | **0 / 26** | 26 / 26 | **26 / 26** |
| relevance hit@5 | 0.0% | 84.6% | **84.6%** |
| hard-negative 平均返回 | 2.81 | — | 2.88 |
| hard-negative semantic-only 均 / 最大 | 1.77 / 2 | — | 1.85 / 2 |

Gate：G5′ PASS（0 条无法解释的新增、0 次 cap 越界）、G6′ PASS（与 full-scoring 参考 0 页差异、
0 来源差异）、G7 PASS（22 改善 / 0 退化）、G8 PASS（2.88 ≤ 相对 3.31 且 ≤ 绝对 4.06）、
G10 PASS（均 1.85 ≤ 2.27，最大 2 ≤ 2）、不变量 PASS（degrade 0/0/0）。

**结论：PASS。**

---

## 逐 query 变化

- **改善**：候选池轮次的 72 条零关键词校准 query 中 43 条从结构上不可达变为可达（收益归属
  候选池轮次）；Codex 盲审集 26 条从 0/26 触达变为 26/26，22 条 hit@5 改善。
- **退化**：**0 条**。gold 239 条与 2,000 条装置 276 条的返回逐位不变；盲审集 0 条退化。
- **不变**：四个 K 的返回页与 full-scoring 参考逐位相同。
- **最大退化**：无结果退化。唯一变差的读数是阶段一的 p99 方差（见上），已由 S3 正面约束。

---

## 测试

```text
bun test          523 pass / 0 fail（阶段一收口时）
bun run typecheck 干净
```

新增/改写（`tests/integration/retrieval-policy.test.ts`）：

| 测试 | 断言 |
| --- | --- |
| 无平局 40 条 | 名次逐键与参考实现相同 |
| **全部同分 25 条** | 名次逐键相同——平局次序不能因为流式而漂移 |
| **真实分块边界 4095 / 4096 / 4097 / 8192** | 逐档与参考实现逐键相同，且 `comparableVectors === n`、`aboveFloorCount === 参考的过 floor 数` |
| K = 1 / 29 / 30 / 31（30 条候选） | 保留集无重复、条数恰为 `min(K, 全量)`、名次值与全量一致（测的是 **K 的收放**，不是分块边界） |
| FTS 命中但分数最低，K=1 | 仍在名次表里、`match_source` 仍是 `hybrid`、名次是**真实全局名次 6** 而不是 `K+1 = 2` |
| 全部候选低于 floor | 语义腿为空，不抛错 |

反向测试实测输出（判据 §7 第 6 条）：

```text
把"额外保留项的真实名次"改成 topK+1        → 2 fail
去掉 FTS 命中的 always-keep               → 2 fail
分块步长 −1（每块漏掉最后一条）             → 2 fail
分块步长重叠 1（边界处重复计入）             → 2 fail
复原                                      → 0 fail
```

**必须登记的一次纠正**：初版报告把 K = 1/29/30/31 那条测试标成"候选数落在块边界与其附近"，
但 30 条候选连一个 4,096 的块都填不满，它测的是 **K 的收放**，根本没触达"块与块之间是否拼接
正确"。这是 **Codex 验收指出的**（发布验收因此未签发），不是自查发现的。已补真实边界测试，
并把旧那条如实改名。上面两条新增的反向测试（步长 −1 / 重叠 1）就是为了证明新测试确实能抓到
拼接错误——在错标的旧测试下，这两种破坏都不会被发现。

---

## 已知限制

1. **50,000 档的文本仍是 10,000 条重复 5 份**（候选池轮次裁定允许）。cosine 分布逐位保留，
   但 FTS 侧命中形状与 50,000 条各自独立的语料不同。
2. **RSS 是 GC 驱动的读数**，跨运行有方差；一律取 ≥3 次复现并写出跨度。
3. **逐位一致只在已冻结装置上验证**（239 + 276 条 query + 50,000 档 20 页）。装置外的 query
   分布可能触发未覆盖的近平局形状——这正是判据 §6.4 要求 Codex 对最终策略重建盲审集的原因。
4. **平局等价依赖 SQLite 的 `IN` 返回顺序是 rowid 升序**。这是实测的，不是文档保证；
   若将来 Bun / SQLite 改变它，旧实现的平局次序也会跟着变，"等价"的参照物本身会移动。
   全同分测试是这条风险的探测器。
5. **块大小 4096 是本机口径**。它不改变任何结果（边界测试覆盖），但最优值依赖内存带宽与 GC。
6. **本轮不改善召回**，一条也没有。收益归属候选池轮次。
7. **B1 修订晚于读数**，预登记强度低于 A0。抵消它的三件事：修订由裁定作出而非自行决定；
   口径是**收紧**（严格口径比中位数与最小值都更难通过）；它同时否掉了当时倾向的方案（∞ 不截断）。
8. **"过 floor 条数"这个诊断字段在每个有限 K 的首轮用的是旧仪表**（统计保留集大小而非真实
   过 floor 数），r2/r3 才是修正后的。该字段不参与任何门槛，详见 `topk-phase2-matrix.md` §5。

---

## Codex 验证状态

**已通过**：`topk/codex-blind-audit.md`（PASS），针对最终策略 `Infinity` + K=1000 重建盲审集。

发布形态：`DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool = Infinity`、`semanticTopK = 1000`。
`LEXICAL_ANCHOR_ROLLBACK_POLICY` 保持 `pool=200` / `semanticTopK=Infinity`（复现 Phase 1b）。

推荐独立复跑命令见 `topk-criteria.md` §10；矩阵全表与逐次复现读数见 `topk-phase2-matrix.md`。
