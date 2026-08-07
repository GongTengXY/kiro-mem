# Phase 3C 提交：时间窗口径统一 —— **不通过（P6 最终失败）**

> ## 最终裁定（2026-08-07）：**不通过**
>
> 最终独立盲审 C1 实测：无界 hard-negative 平均返回 **1.900 > 1**。按冻结判据 §5，
> **P6 不通过，Phase 3C 最终状态由“有条件通过”落为“不通过”**。
>
> P0–P5、Q1–Q6 继续保留为通过证据；盲审同时确认旧记录收益 hit@5 `0% -> 80.77%`
>（21/26、0 退化），但收益不能覆盖安全门失败。
>
> 补救选择另开 floor x cap 安全策略轮次，不回滚 90 天：`days=90` 对照臂自身也是
> **1.800 > 1**，回滚不能修复 C1，却会撤掉已确认收益。工作分支暂时保持默认无界，
> **对外稳定发布继续阻塞**。完整签发见 `final-recall/codex-p6-ruling.md`。

---

以下 2026-08-06 裁决块保留为过程记录，已被上面的最终裁定取代。

> ## 裁决（2026-08-06）：**有条件通过，选项 (c)**
>
> **保留默认无界时间窗，不回滚到 90 天。P6 的最终结论移交第 3 步独立盲审。**
>
> 逐条落档，**不得**把本节改写成"P6 已通过"：
>
> | 门槛 | 裁决 |
> | --- | --- |
> | N1–N6 行为中立 | 通过 |
> | P0–P5 跨边界 | 通过 |
> | Q1–Q6 老语料规模性能 | 通过 |
> | **P6 误召回** | **有条件挂起**，结论由第 3 步的独立盲审集给出 |
>
> ### 为什么不选 (b)（退回有窗）
>
> `days=90` 对照臂本身就以 5.2/10、3.327/10、3.719/10 越界。**不能把基线已有的问题归因给
> 时间窗**，据此回滚是错的归因。
>
> ### 为什么不选 (a)（认定阈值只适用 gold、直接放行）
>
> gold 语料**全部位于旧窗口内**，所以它在结构上无法证明"放宽窗口没有引入旧记录噪声"。
> 用一个测不到该风险的装置去核销该风险，不成立。
>
> ### 挂起的实质理由：净变化 0 掩盖了结果替换
>
> 无界窗口**确实改变了页面组成**。裁决点出 q21 / q23 的总返回都维持 10，而 semantic-only
> 从 0 变成 2——我的"净贡献 +0.000"把这件事盖住了。
>
> 按裁决复核后，这个形状比裁决点出的更多：**7 条 query 的总返回不变、semantic-only 变了**
> （详见 §指标 3.1）。
>
> ### 证据不足在哪
>
> `benchmark/probe-3c-empty-oldcorpus.ts:68` 只记录 `returned` 与 `semanticOnly` 两个**计数**，
> 没有记录有序 `resultIds`、逐项 `match_source`、以及**被挤出页面的结果**。所以"换掉了什么"
> 无法回答，证据不足以无条件放行。
>
> ### 后续约束
>
> 1. 本轮进入 raw-v1 降级语义核验，**保持独立轮次**；不得借 P6 数据调整 floor / cap /
>    Top-K / 时间窗；
> 2. raw 策略冻结后由 Codex 建最终独立盲审集，审计同时记录**有序结果、来源、semantic score、
>    页面新增/替换**，并对照 `days=90`；
> 3. **若最终盲审失败，无界默认不能正式验收**；届时只能回滚时间窗或另开安全策略轮次，
>    不得根据盲审集直接调参。

---

> 判据：`benchmark/reports/phase3c-criteria.md`，A0 `366ce756b0d6ebd0`，
> 冻结于 `2026-08-06T12:10:40Z`，**先于任何实现改动与任何测量**，判据全程未修订。
>
> 上游：Top-K 轮次阶段二已通过 Codex 盲审（`pool=Infinity` + `semanticTopK=1000`）。
> 候选池轮次验收报告要求"3C 放宽时间窗必须等有界流式打分先抬起内存天花板"，该前置已满足。
>
> 本轮是裁定三步收尾的**第 1 步**。第 2 步（raw-v1 降级语义核验）与第 3 步（最终误召回门槛
> 复核）未开始，本轮改动不得用于修饰它们的指标。

---

## 阶段

Phase 3C（方案 §12）。请求验证：**时间窗口径统一**。

---

## 改动范围

### 行为变化：一句话

默认 `search` 从"最近 90 天"变成"全部历史"，与 bootstrap 注入索引的可见范围一致。
显式 `days=N` 行为不变。

### 文件

| 文件 | 改动 |
| --- | --- |
| `src/db/index.ts` | 新增导出常量 `DEFAULT_SEARCH_DAYS = Infinity` 与助手 `searchDateThreshold(days)`（无界时返回 `null`，调用方**省略整个** `turn_stopped_at > ?` 子句）；`searchObservationsFts` 两个分支（FTS + LIKE 兜底）、`searchObservationsByCjkBigrams`、`getRecentObservationIds` 全部改成条件拼接；`getRecentObservationIds` 的 `days` 由必填改为可选 |
| `src/server/observation-search.ts` | 内核默认 `?? 90` → `?? DEFAULT_SEARCH_DAYS`；`ObservationSearchOpts.days` 补语义说明 |
| `src/server/mcp-server.ts` | 删除 schema 的 `default: 90`；`boundedInteger(a.days, DEFAULT_SEARCH_DAYS, 1, 3650)`；中英文 `daysDescription` 改写为"不传则搜索全部历史" |
| `tests/integration/time-window.test.ts` | **新增**，6 条：P0/P1 可见范围一致、P2 显式收窄、P3 跨 scope、P4 type 过滤、P5 语义腿单独召回、P5 补充候选池计数 |
| `tests/integration/mcp-server.test.ts` | 新增 1 条真实 MCP 路径用例（>90 天记录 + schema 无 `default`）；`seedObservation` 支持自定义时间戳 |
| `tests/db/retrieval.test.ts` | 计划测试改为镜像生产的条件拼接，**两种形状都验**（默认无界 / 显式 `days`） |
| `benchmark/run-pool-perf-recheck.ts` | 新增 `--spread-days=N`（老语料装置：同一批文本与向量，只重铺时间戳）；measure 阶段实测语料时间形状并写进 provenance |
| `benchmark/probe-3c-empty-oldcorpus.ts` | **新增**，在老语料上跑三个冻结 empty 集，支持 `--days` 对照臂 |
| `README.md` / `docs/i18n/README.zh.md` | 新增"默认搜索不限时间，也没有保留期策略"限制行（含实测规模上界）；修正"全 scope 与时间窗内"这处已不准确的措辞 |

### 明确未改

`semanticFloor` 0.197 / `semanticOnlyLimit` 2 / `rrfK` 60 / 权重 1:1 / `tieBreak` semantic-rank /
`semanticDiscovery` true / `semanticCandidatePool` Infinity / `semanticTopK` 1000 /
5 个 bigram 字段（`bigramAux` 仍为 `false`）/ FTS tokenizer / 内部 FTS limit 50 /
`ORDER BY fts.rank, o.id ASC` / embedding 模型 / `semantic-en-v1` 协议 / DB schema 与索引 /
bootstrap 的条数上限与字节预算 / raw-v1 降级路径。

### 一处必须点明的结构问题（判据 §4.2）

`?? 90` 原先在**四个层各写了一遍**（内核、db 两个方法、MCP）。只改其中三层，剩下那一层
会继续过滤，而从任何单点读代码都看不出来。判据因此写死"改完 `src/` 下不得再有 90 天兜底"，
实测残留 **0 处代码**（仅 3 处注释提及历史值）。反向测试 R1/R2/R4/R5 分别打在这四层上，
每一层单独恢复都会让测试失败。

---

## Provenance

| 项 | 值 |
| --- | --- |
| commit | `13ad15c`，dirty（工作区含 Phase 1b–本轮未提交产物） |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 判据 | A0 `366ce756b0d6ebd0`，冻结于 `2026-08-06T12:10:40Z`，**无修订** |
| 策略 | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false |
| 唯一自变量 | 默认时间窗 90 天 → 无界 |
| 对照基线 | `topk/phase2-final-gold.json`（gold 239 query）、`topk/phase2-final-recall.json` 的 `pool-full`（2,000 条装置 276 query）——同策略、改动前 |
| 复用装置 | 30 条 gold；2,000 条 recall-scale（filler `10b572bd3ec7e4b9`）；`pool-policy-filler-10k`（`bbb3a6739cd4bed8`） |
| 新建装置 | 跨边界集成装置（内联，−1d/−45d/−100d/−400d + 外部 scope −400d）；老语料规模装置（同一 filler，时间戳铺开 1,095 天，实测 91.8% 在旧窗外） |

完整命令见 `phase3c-identity.md` §5、`phase3c-boundary.md` §5、本文件 §4。

---

## 指标

### 1. 行为中立（阶段一，现有装置）—— 全过

| # | 门槛 | 读数 |
| --- | --- | --- |
| N1 | gold 239 query 有序 `resultIds` | 差异 **0** |
| N2 | summary 指标 + 17 gate | 差异 0（仅 `latencyP50/P95` 变动）；gate ok 逐条一致 |
| N3 | 2,000 条装置 276 query 有序 `resultIds` | 差异 **0** |
| N4 | 名次 / 分数 / `comparableVectors` | 逐 query 相同（41 + 16 个字段零差异） |
| N5 | 泄漏 / 协议混排 / `semanticOnlyMax` | 0 / 0 / 2 |
| N6 | `bun test` / `typecheck` | **530 pass / 0 fail** / 干净 |

详见 `phase3c-identity.md`。

### 2. 跨边界正面证据（阶段二）—— P0–P5 全过

改动前实测 **1 pass / 5 fail**（矛盾成立，`comparableVectors` 实测 0）；改动后 **6 pass / 0 fail**。
反向测试 5 条，实测 5/5/2/1/1 fail，复原 0 fail。

详见 `phase3c-boundary.md` §1–§3。

### 3. P6 误召回 —— **前置证据（当时挂起，最终已判不通过）**

50,000 条、跨 1,095 天、91.8% 在旧窗外的语料上，同一批冻结 empty 集，两条臂对照：

| 集合 | `days=90`（改前）返回 均/坏 | 无界（改后）返回 均/坏 | 净贡献 | semantic-only 最大 |
| --- | --- | --- | ---: | :--: |
| expected-empty（5） | 5.2 / 10 | 5.2 / 10 | **+0.000** | 2 → 2 |
| phase2 empty（49） | 3.327 / 10 | 3.347 / 10 | **+0.020** | 2 → 2 |
| empty-ext（32） | 3.719 / 10 | 3.813 / 10 | **+0.094** | 2 → 2 |

绝对值越过了判据写的 ≤1 / ≤3，**但改前那条臂同样越界**，所以越界来自这份合成 filler 语料，
不是时间窗。判据 §6.2 P6 没有指明装置，而 `≤1 / ≤3` 是 gold 语料校准出来的阈值——这是我
判据写法的缺陷，如实登记，不自行修改判据。在 gold 语料上该读数**未变**（均 1.00 / 坏 2）。

#### 3.1 上面这张表有一个被裁决点破的缺陷：净变化 0 掩盖了结果替换

"净贡献 +0.000 / +0.020 / +0.094"只统计了**返回条数**。裁决指出 q21 / q23 的总返回都是 10、
而 semantic-only 从 0 变成 2 —— 页面组成变了，条数没变，于是我的指标看不见它。

按裁决复核全部 86 条 query，这个形状共 **7 条**（比裁决点出的 2 条更多）：

| 集合 | query | `returned`（90 → 无界） | `semanticOnly`（90 → 无界） |
| --- | --- | ---: | ---: |
| expected-empty | q21 | 10 → 10 | 0 → **2** |
| expected-empty | q23 | 10 → 10 | 0 → **2** |
| phase2 empty | f02 | 10 → 10 | 0 → **2** |
| phase2 empty | f07 | 10 → 10 | 0 → **2** |
| empty-ext | n08 | 10 → 10 | 0 → **2** |
| empty-ext | n27 | 10 → 10 | 0 → **2** |
| empty-ext | n29 | 10 → 10 | **2 → 0**（反方向） |

七条全部是满页（10 条）的 query，所以新进来的 semantic-only **必然挤掉了**同样数量的原有
结果，而 `returned` 完全无法反映这件事。n29 的反方向变化说明这不是单调的"多塞两条噪声"，
而是页面重组。

**证据缺口（裁决认定，不辩解）**：`benchmark/probe-3c-empty-oldcorpus.ts:68` 只记了两个计数，
没记有序 `resultIds`、逐项 `match_source`、被挤出的结果与 semantic score。所以"换掉了什么、
换进来的是否更差"本轮回答不了。补齐口径由第 3 步的独立盲审承担，**不在本轮补测**——本轮
若自己去补一个新指标再自我判定，等于看到读数之后改判据。

需要单独盯的一处：expected-empty 那 5 条的 semantic-only 均值 1.2 → **2.0**，即
**配额被填满**（仍未越 cap）。2C 标注过这个集合"没有余量"，现在余量确实用完了。

详见 `phase3c-boundary.md` §4。

### 4. 老语料规模性能（阶段三）—— Q1–Q6 全过，每次复现都达标

50,000 条、跨 1,095 天、91.8%（45,890 条）落在旧窗之外。三次独立进程复现：

| run | p50 | p95 | p99 | 循环内 RSS 增量 | 进程峰值 | 样本 | degrade |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 136.42ms | **260.32ms** | 453.31ms | **+278MB** | 409MB | 200 | 0 |
| 2 | 132.65ms | **242.70ms** | 400.15ms | **+264MB** | 395MB | 200 | 0 |
| 3 | 132.35ms | **203.39ms** | 359.27ms | **+294MB** | 423MB | 200 | 0 |
| 门槛 | — | < 300ms | < 500ms | ≤ 512MB | ≤ 1024MB | ≥ 200 | 0 |

聚合口径沿用 Top-K 轮次裁定 B1 的**严格口径**（每次复现都需达标，不接受中位数、不接受
"最小值 + 分布"）。三次全部达标。

`comparableVectors` 实测 **50,000**（全部记录进入打分），过 floor 均 4,618 / 最坏 14,830 条
——与 Top-K 轮次在同一 filler 上的读数逐位相同，确认时间戳重铺没有改变 cosine 分布。

**预登记预测的兑现情况**：判据 §6.3 在看到读数之前写下"时间窗只做减少工作量，所以新默认
的成本上界 = 已测的全部记录都在窗内的成本；Top-K 轮次读数 p95 158–286ms / RSS +225…+324MB，
本轮应落在同一量级或更低"。实测 p95 203–260ms / RSS +264…+294MB，**落在同一量级**，预测成立。

**静态证据（判据 §6.3 要求的计划对照）**，在同一个 50,000 条老语料库上：

| 语句 | 改后（默认无界） | 改前（有阈值 / 等于显式 `days=N`） | 结论 |
| --- | --- | --- | --- |
| FTS 腿 | `SCAN fts VIRTUAL TABLE` → `SEARCH o USING INTEGER PRIMARY KEY` → `USE TEMP B-TREE` | **逐行相同** | 去掉谓词**没有翻转驱动表**，FTS 虚表仍是外层循环 |
| 候选池扫描 | `SEARCH observations USING COVERING INDEX idx_observations_scope_time (scope_key=?)` | 同一索引，多一个 `turn_stopped_at>?` 约束 | 仍走 `idx_observations_scope_time`，只是扫同一索引的更多部分，**没有退化成全表扫描** |

产物：`phase3c/perf-oldcorpus-50000-r{1,2,3}.json`、`phase3c/explain-plan-comparison.json`。

---

## 逐 query 变化

- **改善**：`tests/integration/time-window.test.ts` 的 −100d / −400d 两条记录，从
  "bootstrap 索引里可见但默认 search 搜不到"变成可召回；语义腿的 `comparableVectors` 0 → 2。
- **退化**：现有装置上 **0 条**（N1/N3 逐位一致）。老语料 empty 集上返回条数变化的 query 共
  **3 条**（phase2 empty 1 条、empty-ext 2 条），最大变化为 +1 条返回，全部仍在 cap 内。
- **不变**：gold 239 条 query 与 2,000 条装置 276 条 query 的返回**逐位不变**。
- **最大退化**：expected-empty 5 条的 semantic-only 均值 1.2 → 2.0（配额填满，未越 cap）。

---

## 测试

```text
bun test          530 pass / 0 fail（47 文件）
bun run typecheck 干净
```

新增/改写：

1. `tests/integration/time-window.test.ts` —— 6 条（新文件）；
2. `tests/integration/mcp-server.test.ts` —— 新增 1 条真实 MCP 路径用例；
3. `tests/db/retrieval.test.ts` —— 计划测试改为覆盖两种形状。

反向测试实测输出（判据 §7 第 6 条）：

```text
R1 内核默认改回 90                          → 5 fail
R2 searchDateThreshold 把无界当成 90 天      → 5 fail
R3 只放宽 FTS 腿、候选池仍夹到 90 天          → 2 fail（恰为两条 P5）
R4 MCP 层 boundedInteger 兜底恢复 90         → 1 fail
R5 MCP schema 恢复 default: 90              → 1 fail
R6 CROSS JOIN 改回普通 JOIN（计划测试）        → 3 fail
复原                                        → 0 fail
```

**必须登记的一次自我纠正**：第一轮反向测试三条**全部没能失败**。原因是内核在
`observation-search.ts:1096/1241` 显式下传 `days`，db 层的 `?? 兜底`对生产路径是死代码——
我破坏的是路径外的东西，测试因此"通过"得毫无意义。重做后才打在真正的决策点上。
这不是 Codex 指出的，是自查发现的，但如果不写出来，R1–R5 看起来会像一次就设计对了。

---

## 已知限制

1. **跨边界证据来自小装置**（4 条同 scope + 1 条外部 scope）。它证明**机制**——时间窗不再
   过滤、scope/type 过滤仍生效、语义腿能独立触达——不是泛化的召回收益。本轮**没有**跨 90 天
   的标注召回集，因此不声称"找回了多少真实旧记忆"。
2. **老语料装置是时间戳重铺**，文本仍是 10,000 条 filler 各重复 5 份（候选池轮次裁定允许）。
   它测的是"旧记录不再被挡住之后的成本"，不是真实三年语料的 FTS 命中形状。
3. **早期 P6 装置的绝对阈值口径存在缺陷**（gold 校准的 ≤1/≤3 套到含 FTS filler 的语料上），
   已在 §指标 3 与 `phase3c-boundary.md` §4.3 登记。最终盲审改用 30 条零 FTS hard-negative，
   C1 仍以 **1.900 > 1** 失败，因此 P6 已最终判为不通过。
4. **早期 P6 探针只记计数，测不到页面替换**。最终盲审已经补齐有序结果、来源、semantic score、
   页面新增与替换；该证据在 `final-recall/codex-blind-audit-result.json`。
5. **RSS 是 GC 驱动读数**，三次复现跨度 +264…+294MB 已全部留档。
6. **无界默认意味着成本随语料无上限增长**。当前证据的规模上界是 **50,000 条 / 3 年**；
   超过该规模未测。已写进 README 与中文 README。
7. **保留策略仍然缺失**。3.x 没有删除或过期机制；放宽窗口之后"永久保留"从存储问题变成
   同时是检索成本问题。本轮只登记，不解决。
8. **本轮不改善相关性排序**，一条也没有。
9. **无界默认未通过正式验收**。最终选择另开安全策略轮次；工作分支暂时保留无界以保留
   21/26 的旧记录收益，但对外稳定发布继续阻塞，且不得根据已消耗盲审集直接调参。

---

## Codex 验证状态

对应：裁定三步收尾的**最终状态**。

**已裁定（2026-08-07）：Phase 3C 不通过。** 落点：

- N1–N6 / P0–P5 / Q1–Q6 通过；
- raw-v1 FTS-only 独立核验通过；
- 最终盲审 B 组通过，但 C1 `1.900 > 1`，故 P6 不通过；
- 工作分支保留默认无界，对外稳定发布阻塞；
- 下一步进入 `final-recall/codex-p6-ruling.md` 定义的 floor x cap 安全策略轮次。

推荐独立复跑命令：

```bash
# 行为中立
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --fusion --empty-ext \
  --no-heldout --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 \
  --fts-weight=1 --semantic-weight=1 --tie-break=semantic-rank --semantic-candidate-pool=inf \
  --semantic-topk=1000 --bigram-aux=off --json=/tmp/verify-3c-gold.json
bun run benchmark/run-phase3b-scale.ts --pools=full --sizes=0 --json=/tmp/verify-3c-recall.json

# 跨边界 + 反向
bun test tests/integration/time-window.test.ts tests/integration/mcp-server.test.ts tests/db/retrieval.test.ts

# 老语料规模与 P6
bun run benchmark/run-pool-perf-recheck.ts --phase=seed --size=50000 --spread-days=1095 --db=/tmp/v3c.db
bun run benchmark/run-pool-perf-recheck.ts --phase=measure --size=50000 --spread-days=1095 \
  --db=/tmp/v3c.db --pools=full --rounds=11 --json=/tmp/verify-3c-perf.json
bun run benchmark/probe-3c-empty-oldcorpus.ts --db=/tmp/v3c.db --json=/tmp/verify-3c-p6-unbounded.json
bun run benchmark/probe-3c-empty-oldcorpus.ts --db=/tmp/v3c.db --days=90 --json=/tmp/verify-3c-p6-days90.json

# §4.2 残留检查
grep -rn "?? 90\|90 \* 86400000\|default: 90" src/
```
