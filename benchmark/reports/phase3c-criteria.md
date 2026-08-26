# Phase 3C 时间窗口径统一判据（预登记，冻结于任何实现与测量之前）

> 版本 A0。冻结时间与正文哈希见 §10。
>
> 上游：Top-K 轮次阶段二**已选定并通过 Codex 盲审**（`pool=Infinity` + `semanticTopK=1000`，
> `benchmark/reports/topk/codex-blind-audit.md`）。候选池轮次的验收报告
> （`pool-policy-codex-acceptance.md` §Follow-up boundary）明确要求：**3C 放宽时间窗必须等
> 有界流式打分先把内存/规模天花板抬起来**。该前置条件现已满足。
>
> 方案依据：`plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §12。
>
> 执行顺序依据：本轮是裁定的三步收尾中的第 1 步。第 2 步（raw-v1 降级语义核验）与第 3 步
> （最终误召回门槛复核）**不在本轮范围**，且不得用本轮改动去修饰它们的指标。

---

## 1. 本轮要解决的问题

产品自相矛盾，且两侧口径是实测确认的，不是推断：

| 路径 | 时间过滤 | 代码位置 |
| --- | --- | --- |
| bootstrap 注入的 Observation 索引 | **完全没有** —— SQL 里不存在 `turn_stopped_at > ?`，只有条数上限（置顶 5 + 详情 5 + 索引 50） | `src/db/index.ts:1491` `getPinnedObservations`、`src/db/index.ts:1505` `getRecentObservations`；调用方 `src/bootstrap-context.ts` |
| 默认 `search` | **90 天** | `src/db/index.ts:1133`（FTS + LIKE 兜底）、`src/db/index.ts:1319`（bigram 腿）、`src/server/observation-search.ts:1066`（内核）、`src/server/mcp-server.ts:241,355`（MCP schema `default: 90` 与参数兜底） |

于是一个闲置四个月的 workspace，会话开头的索引里明明列着 `#O42`，Agent 按索引去 `search`
却搜不到它。这不是相关性问题，是**同一个产品里两个可见范围不一致**。

顺带登记一个必须一起改掉的结构问题：`?? 90` 在**四个层各写了一遍**。只改内核不改 db 层，
或只改 MCP 不改 db 层，都会留下一个仍在过滤的路径，而且从任何单点读代码都看不出来。

---

## 2. 产品语义裁定（本轮不再讨论）

方案 §12 给了两个选项：默认搜索不限天数，或 bootstrap 与 search 用同一个默认窗口。

**裁定取前者：默认 `search` 放宽到全历史，与 bootstrap 的可见范围一致。**

理由与"哪边更好看"无关，而是两条：

1. bootstrap 侧本来就没有窗，把它加上窗等于**减少**用户能看到的历史，是功能回退；
2. `days` 已经是 MCP schema 里的显式参数，收窄能力不会丢——变的只是**不传时的默认**。

`days` 保留为显式收窄参数，行为不变。

---

## 3. 明确的非目标（禁止项）

任一项发生即判本轮污染，不论结果好坏：

1. 修改 `semanticFloor` / `semanticOnlyLimit` / `rrfK` / 两路权重 / `tieBreak` /
   `semanticDiscovery` / `semanticCandidatePool` / `semanticTopK`；
2. 修改 5 个 bigram 字段中的任何一个（`bigramAux` 保持 `false`，3A 路线已收口）；
3. 修改 embedding 模型、`semantic-en-v1` 协议、FTS tokenizer、内部 FTS limit 50、
   `ORDER BY fts.rank, o.id ASC`；
4. 修改 DB schema 或索引定义；
5. 修改 bootstrap 的条数上限（置顶 5 / 详情 5 / 索引 50）或字节预算；
6. 触碰 raw-v1 降级路径的语义（那是裁定的第 2 步，本轮只能保持现状）；
7. 用"empty 集没变差"替代**跨 90 天边界**的正面证据——现有装置全部落在窗内，见 §5。

---

## 4. 目标实现规格

### 4.1 "无界"的表达方式

`days = Number.POSITIVE_INFINITY` 表示不限时间，SQL 中**不出现** `turn_stopped_at > ?` 子句，
由 `Number.isFinite(days)` 决定是否拼接。

选这个表达而不是 `undefined`、也不是"一个很大的数"，理由是本仓库已有同一个惯例，不新造一套：

- `semanticCandidatePool: Number.POSITIVE_INFINITY` 表示全 scope 候选池；
- `semanticTopK: Number.POSITIVE_INFINITY` 是回滚 profile 的"不截断"；
- `getRecentObservationIds` 已经在用 `if (Number.isFinite(opts.limit))` 决定是否拼 `LIMIT`。

"一个很大的数"（例如 3650）被明确排除：它是一道**隐藏的悬崖**——十年零一天前的记录会静默
消失，而代码里没有任何一行说明那是有意的。

### 4.2 唯一常量

新增一个导出常量 `DEFAULT_SEARCH_DAYS = Number.POSITIVE_INFINITY`，定义一次，四个层全部引用它。

**判据要求：改完之后，`src/` 下不得再有任何一处 `?? 90` 或等价的 90 天兜底。**
留下任何一处即本轮不通过——那正是 §1 登记的结构问题。

### 4.3 两路口径必须一致

FTS 腿、语义腿、bigram 腿（即使当前关闭）必须使用**同一个** `days` 值。不允许出现一路有窗、
一路无窗。方案 §2.1 第 7 条把这条列为架构结论。

### 4.4 显式 `days` 不变

`days=N` 仍然收窄到最近 N 天。MCP schema 的 `minimum: 1` / `maximum: 3650` 保留（它约束的是
显式收窄值，与默认无界不冲突）；`default: 90` 必须删除，否则 schema 会向 Agent 谎报默认行为。

---

## 5. 装置与数据纪律

### 5.1 一个必须先写下来的事实：现有装置全部在窗内

所有现有基准装置的播种基点是**当天 UTC 零点 − 30 天**，之后逐条按分钟/秒递增：

| 装置 | 播种基点 | 跨度 | 是否跨 90 天 |
| --- | --- | --- | :--: |
| 30 条 gold 语料（239 query） | `benchmark/run.ts:571` `dayStartUtc - 30d`，+1 分钟/turn | 30 分钟 | 否 |
| 2,000 条 recall-scale（276 query） | `run-phase3b-scale.ts:138` 同口径 | — | 否 |
| 10,000 / 50,000 performance-scale | `run-pool-perf-recheck.ts:105` 同口径，+1 秒/条 | ≤13.9 小时 | 否 |

**因此**：现有装置只能证明**行为中立**（去掉窗不该改变任何东西），**不能**证明问题被修好。
正面证据必须来自新建的跨边界装置。把"现有装置没变差"当成本轮成功证据，是 §3 第 7 条禁止项。

### 5.2 新建装置（本轮唯一允许新建的数据）

| 装置 | 形态 | 用途 |
| --- | --- | --- |
| 跨边界正确性装置 | 集成测试内联播种，同 scope 记录落在 −1d / −45d / −100d / −400d，另加一条外部 scope 的 −400d 记录 | §6.2 的 P1–P6 |
| 老语料规模装置 | 复用 50,000 条 performance-scale，把播种跨度改成 1,095 天（约 96% 落在 90 天外）；**向量与文本内容不变**，只改时间戳分布 | §6.3 的 Q1–Q6 |

老语料装置**不引入新语料**：它是同一份 `pool-policy-filler-10k`（sha16 `bbb3a6739cd4bed8`）
的时间戳重铺，因此 cosine 分布逐位不变，唯一自变量是"有多少条落在旧窗口之外"。

---

## 6. 门槛（先写死，看到任何读数之前）

### 6.1 阶段一：行为中立（现有装置，记录全部在窗内）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| N1 | 30 条 gold 语料 239 条 query 的有序 `resultIds` | **逐位相同**，差异 0 |
| N2 | 30 条语料全部 summary 指标 + 17 个 gate | 完全一致，gate 全过 |
| N3 | 2,000 条装置 276 条 query 的有序 `resultIds` | **逐位相同**，差异 0 |
| N4 | `semanticRank` / `semanticScore` / `comparableVectors` | 逐 query / 逐键相同 |
| N5 | 跨 scope 泄漏 / 协议混排 / `semanticOnlyMax` | 0 / 0 / ≤2 |
| N6 | `bun test` + `bun run typecheck` | 全通过 / 干净 |

N1–N4 是**硬性逐位一致**。这些装置的记录本来就都在 90 天内，所以去掉窗**在数学上不该**改变
任何一条返回。出现差异只有两种解释：改动碰到了时间窗以外的东西，或者原实现里有依赖该阈值的
副作用——两种都必须查清而不是放宽门槛。

### 6.2 阶段二：跨边界正面证据（新装置）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| P0 | **反向证据**：改动**之前**，−100d / −400d 的记录必须"bootstrap 索引里有、默认 search 搜不到" | 必须实测到该矛盾；测不到则说明问题描述本身错了，本轮应停下重新调查 |
| P1 | 改动之后，默认 `search` 能召回 −100d 与 −400d 的记录 | 两条都能召回 |
| P2 | 显式 `days=90` 仍然过滤掉它们 | 仍被过滤 |
| P3 | scope 过滤对 >90 天记录仍生效 | 外部 scope 的 −400d 记录**永不返回**，泄漏 0 |
| P4 | type 过滤对 >90 天记录仍生效 | `type` 不匹配时不返回 |
| P5 | **语义腿**（不只是 FTS 腿）能召回 >90 天记录 | 用零词面重叠的 query + 合法 `semantic_query_en`，−400d 记录以 `match_source: semantic` 返回 |
| P6 | 放宽窗口不得把旧的无关记录灌进 empty query | empty / hard-negative 平均返回 ≤1、最坏 ≤3、`semanticOnlyMax` ≤2 |

P5 单独列出，因为语义候选池走的是 `getRecentObservationIds(days)` 这条独立路径：只改 FTS 腿
会让"索引里看得到、语义搜不到"这个矛盾原地保留，而 FTS 腿的测试会通过。

### 6.3 阶段三：老语料规模性能（50,000 条，约 96% 在旧窗口之外）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| Q1 | 完整 search p95 | < 300ms |
| Q2 | 完整 search p99 | < 500ms |
| Q3 | 检索进程循环内 RSS 增量 | ≤ 512MB |
| Q4 | 检索进程绝对峰值 RSS | ≤ 1024MB |
| Q5 | 样本数 / 复现次数 | 每次 ≥200，≥3 次复现，**每次都需达标** |
| Q6 | degrade | 0 |

Q5 沿用 Top-K 轮次裁定 B1 的严格聚合口径（不接受中位数，不接受"最小值 + 报告分布"）。

**预登记的预测**（写在看到读数之前，用于判断结论是否有判别力）：时间窗只做**减少工作量**，
所以同一记录数下新默认的成本上界 = 已测的"全部记录都在窗内"成本。Top-K 轮次在 50,000 条全部
入窗时测得 p95 158–286ms、循环内 RSS +225…+324MB。因此本轮读数应落在**同一量级或更低**
（少了一个谓词）。若显著更差，说明去掉阈值改变了**查询计划**而不只是改变了行数，那必须单独
查清并登记，不能用"仍在预算内"掩盖。

同时必须交付一项静态证据：`EXPLAIN QUERY PLAN` 改前 / 改后对照，覆盖 FTS 腿与候选池扫描两条
语句，确认 `idx_observations_scope_time` 仍被使用。

### 6.4 失败分支（先写死）

- N1–N6 任一失败 → 修实现，不修门槛；
- P0 测不到矛盾 → 停下，重新调查问题是否存在；
- P1–P5 任一失败 → 本轮未通过，如实写出哪一层仍在过滤；
- P6 失败 → 放宽窗口引入了误召回，**默认必须退回有窗**，并把该证据交给裁定的第 3 步；
- Q1–Q6 任一失败 → 默认不得放宽到全历史；此时的合法结论是"全历史在当前规模下不可负担"，
  而不是"改小一点凑过门槛"。凑参数属于改产品语义，需要新一轮判据。

---

## 7. 必须新增的测试

方案 §12 明文要求：「集成测试必须包含一条超过 90 天的记录，并验证 bootstrap 和默认 search
行为一致」。落点如下：

1. bootstrap 索引与默认 search 在同一 scope 上**可见集合一致**（含 −400d 记录）；
2. 显式 `days=90` 仍收窄；
3. `type` 过滤对 >90 天记录生效；
4. 跨 scope：外部 scope 的 −400d 记录即使 cosine 完美也不返回；
5. 语义腿单独召回 >90 天记录（零词面重叠 + 合法英文形式），`match_source` 为 `semantic`；
6. **反向测试**（判据要求实测输出，不接受声称）：
   - 把 db 层任一处的 `?? 90` 恢复 → 上述测试必须失败；
   - 只改 FTS 腿、不改候选池 → 第 5 条必须失败。

没有反向测试实测输出的新增测试不计入交付。

---

## 8. 交付物

1. 本判据（A0 冻结）；
2. `benchmark/reports/phase3c-identity.{md,json}`：阶段一逐位一致证据；
3. `benchmark/reports/phase3c-boundary.md`：阶段二 P0–P6 逐条证据，含改动前的 P0 反向读数；
4. `benchmark/reports/phase3c-perf-oldcorpus.json` × 3 次复现 + `EXPLAIN QUERY PLAN` 对照；
5. `benchmark/reports/phase3c-submission.md`（按方案 §15 模板）；
6. 测试清单与反向测试实测输出。

---

## 9. 先写下来的已知限制

1. **跨边界证据来自新建的小装置**（4 条同 scope 记录 + 1 条外部 scope），它证明的是**机制**
   ——时间窗不再过滤、其他过滤仍生效——不是泛化的召回收益。本轮没有跨 90 天的**标注召回集**，
   因此不声称"找回了多少真实旧记忆"。
2. **老语料规模装置是时间戳重铺**，文本仍是 10,000 条重复 5 份（候选池轮次裁定允许）。它测的是
   "旧记录不再被窗口挡住之后的成本"，不是真实三年语料的 FTS 命中形状。
3. **RSS 是 GC 驱动的读数**，跨运行有方差，一律取 3 次复现并写出跨度。
4. **本轮不改善相关性排序**。收益是"原本搜不到的旧记录现在可达"，与 floor/cap/RRF 无关。
5. **无界默认意味着成本随语料无上限增长**。当前证据的规模上界是 50,000 条；超过该规模的行为
   未测。本轮必须把这个上界写进 README，不得留白。
6. **保留策略仍然缺失**。3.x 没有任何删除或过期机制，放宽窗口之后"永久保留"从存储问题变成
   同时是检索成本问题。本轮只登记，不解决。

---

## 10. Provenance

| 项 | 值 |
| --- | --- |
| 判据文件 | 本文件 |
| 冻结口径 | SHA-256 前 16 位，取**本表 checksum / 时间两行填入之前**的正文 |
| 冻结时点 | **先于任何实现改动与任何测量** |
| 上游策略（本轮不得改动） | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 权重 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false |
| 复用装置 | 30 条 gold（239 query）；2,000 条 recall-scale（filler `10b572bd3ec7e4b9`）；50,000 档回放（`pool-policy-filler-10k` `bbb3a6739cd4bed8`） |
| 新建装置 | 跨边界集成装置（内联）；老语料规模装置（同一 filler 的时间戳重铺，跨度 1,095 天） |
| A0 checksum | `366ce756b0d6ebd0` |
| A0 冻结时间 | `2026-08-06T12:10:40Z` |
