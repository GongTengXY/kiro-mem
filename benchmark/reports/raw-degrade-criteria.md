# raw-v1 降级路径收口判据（预登记，冻结于任何实现与测量之前）

> 版本 A0。冻结时间与正文哈希见 §9。
>
> 上游：`benchmark/reports/raw-degrade-investigation.md`（现状调查，实测 B 臂在 302 条装置上
> 把 900 天前、词面毫无关系的记录以 `match_source: semantic` 送进页面）。
>
> **裁定：降级路径 = FTS-only。不采用 Phase 1b raw policy。** 裁定理由与冻结的产品语义
> 逐条抄录在 §2，本轮不再讨论。
>
> 本轮是裁定三步收尾的**第 2 步**。Phase 3C 保持"有条件通过、P6 挂起"；本轮**不得**借用
> P6 数据，也**不得**调整 `semanticFloor` / `semanticOnlyLimit` / `semanticTopK` /
> `semanticCandidatePool` / 时间窗。

---

## 1. 要修的路径

`src/server/observation-search.ts:1151` 起的词面锚点门只拦 `ftsCount === 0`：

```ts
if (!discoveryEffective && ftsResults.length === 0 && bigramRankMap.size === 0) { ... return []; }
```

于是 `semantic_query_en` 缺失或被拒、但 FTS 有 ≥1 条命中时，`raw-v1` 的语义腿照跑，并且读的是
为 `semantic-en-v1` 校准的三个值（`semanticFloor` 0.197、`semanticCandidatePool` Infinity、
`semanticTopK` 1000）。实测后果（调查报告 §2，302 条装置）：

| arm | protocol | `comparableVectors` | ghost（900 天前、零词面重叠、cosine 0.30） |
| --- | --- | ---: | --- |
| 降级 + 1 条 FTS 命中（**当前生产**） | `raw-v1` | **302** | **进页，`match_source: semantic`** |
| 降级 + 零 FTS 命中 | `raw-v1` | 0 | 返回空（门生效） |

`raw-v1` 没有可辩护的 cosine floor：标注正例 0.080–0.607 与最坏噪声 0.431 **区间重叠**。
调查同时确认 Phase 1b 的 ghost 没进页**不是 floor 0.2 起了作用**（0.30 > 0.2 仍过 floor），
而是最近 200 条候选池挡住的——那是**时间截断**，不是相关性护栏。

---

## 2. 冻结的产品语义（裁定原文，逐条落档）

1. `semantic_query_en` **缺失或被护栏拒绝**时，一律**不生成 query embedding、不读取或比较
   raw 向量**，只返回词面检索结果；
2. 该规则**不受 `semanticDiscovery` 开关影响**。显式回滚 profile 也不能重新启用 raw 语义腿；
3. **合法** `semantic_query_en` 配合显式回滚时，继续保持 Phase 1b 的"有词面锚点才运行
   `semantic-en` 重排"行为；
4. 因此**无需为 raw 分叉时间窗**。FTS 继续遵守默认无界或调用方显式传入的 `days`；
5. `LEXICAL_ANCHOR_ROLLBACK_POLICY` **不再宣称**对"缺失 / 被拒英文派生值"逐字段复现 Phase 1b；
   文档必须登记这是一次**有意的安全修正**，不是回滚 profile 的实现瑕疵。

### 2.1 由此推出的、必须写进代码的不变量

- `protocol === raw-v1` ⟹ 语义腿不执行：`embedCalls = 0`、`comparableVectors = 0`、
  `semanticCount = 0`、`aboveFloorCount = 0`、`semanticRank` 为空；
- `raw-v1` 请求的结果里**不得出现** `match_source` 为 `semantic` 或 `hybrid`
  （`hybrid` 的定义是"语义证据 + 可靠词面证据"，raw 打分不再产生语义证据）；
- 这不是 `policy` 字段，是**不变量**：不允许通过任何 profile 或 benchmark arm 打开。

---

## 3. 明确的非目标（禁止项）

任一项发生即判本轮污染：

1. 修改 `semanticFloor` / `semanticOnlyLimit` / `rrfK` / 两路权重 / `tieBreak` /
   `semanticCandidatePool` / `semanticTopK`；
2. 修改默认时间窗或为 raw 分叉时间窗（裁定第 4 条已排除）；
3. 修改 5 个 bigram 字段（`bigramAux` 保持 `false`）；
4. 修改 FTS tokenizer、内部 FTS limit 50、`ORDER BY fts.rank, o.id ASC`、MCP schema、
   embedding 模型、`semantic-en-v1` 协议与护栏判定规则、DB schema；
5. 改变**合法** `semantic-en-v1` 请求的任何返回；
6. 借用 Phase 3C P6 的数据做任何论证。

---

## 4. 覆盖面（裁定指定，逐项写死）

护栏的拒绝原因来自 `src/semantic-en.ts` 的 `checkSemanticEnQuery`，全部枚举必须覆盖：

| 情形 | 触发方式 | 裁定点名 |
| --- | --- | :--: |
| `missing` | 完全不传 `semantic_query_en` | ✅ |
| `empty` | 传空串 / 纯空白 | — |
| `placeholder` | 传占位文本（`isPlaceholderText`） | ✅ |
| `untranslated`（CJK 比例超限） | 传中文原文 | ✅（中文回显） |
| `untranslated`（identical to source） | 中文 query 原样回显 | ✅（中文回显） |
| `lost_tokens` | 丢掉受保护 token | ✅（protected-token 丢失） |
| `too_long` | 超 `QUERY_MAX_CHARS` | — |
| `length_ratio` | 长度比越界 | — |

未被裁定点名的三项（`empty` / `too_long` / `length_ratio`）同样纳入，理由是它们走的是同一条
`check.ok === false` 分支——只测被点名的四项，会让"分支覆盖"看起来完整而实际按 reason 分叉。

---

## 5. 门槛（先写死，看到任何读数之前）

### 5.1 降级路径必须是 FTS-only（G 组）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| G1 | 上表**全部 8 种**情形 + FTS 有命中：`embedCalls` | **0** |
| G2 | 同上：`comparableVectors` / `semanticCount` / `aboveFloorCount` | **0 / 0 / 0** |
| G3 | 同上：结果的 `match_source` | 只允许 `fts`；出现 `semantic` 或 `hybrid` 即失败 |
| G4 | 同上：返回集合 | 与"同一 query 在纯 FTS 下的有序结果"**逐位相同** |
| G5 | 降级 + **零** FTS 命中 | 返回空，且 `embedCalls = 0` |
| G6 | 302 条 / 900 天 ghost 装置（调查报告 §2 的同一装置） | ghost **不得进页**，任何降级情形下 |
| G7 | `semanticDiscovery = false`（显式回滚）+ 缺失/被拒英文形式 | 仍然 FTS-only，`embedCalls = 0`（裁定第 2 条） |

`embedCalls` 是**注入的计数器**（`generateEmbedding` 被调用的次数），不是从
`comparableVectors` 推断的。理由：`comparableVectors = 0` 也可能是"算了 embedding 但一条向量
都没读到"，那不满足裁定第 1 条"不生成 query embedding"。两者必须分开断言。

### 5.2 合法路径必须行为中立（N 组）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| N1 | 30 条 gold 语料 239 条 query 的有序 `resultIds` | **逐位相同**，差异 0 |
| N2 | 全部 summary 指标 + 17 个 gate（p50/p95 除外，gate ok 状态须一致） | 一致 |
| N3 | `semanticRank` / `semanticScore` / `comparableVectors` / `matchSources` | 逐 query 相同 |
| N4 | 2,000 条装置 276 条 query 的有序 `resultIds` | 差异 0 |
| N5 | 合法英文形式 + `semanticDiscovery = false` | 仍是"有词面锚点才重排"（裁定第 3 条），逐 query 与改动前一致 |
| N6 | `bun test` + `bun run typecheck` | 全通过 / 干净 |

gold 语料 239 条 query **全部**带合法英文派生值（这是调查报告 §3 的结论），因此 N1–N4 预期
逐位不变；出现差异说明改动碰到了合法路径。

### 5.3 既有降级能力不得回归（D 组）

| # | 门槛 | 阈值 |
| --- | --- | --- |
| D1 | 合法英文形式 + embedding 超时 / Worker 故障 | 仍按现有逻辑降级为 FTS-only，`onDegrade` 被调用 |
| D2 | 合法英文形式 + FTS 有命中 + embedding 失败 | 仍返回 FTS 结果（不是空） |
| D3 | `scope` / `type` / `days` / `limit` 过滤 | 在降级路径上与合法路径上行为一致，跨 scope 泄漏 0 |

D1/D2 必须与本轮的新行为**分开断言**：embedding 失败是**能力失败**（要报 `degraded`），
缺失英文形式是**协议不适用**（不报 `degraded`）。两者产生同样的 FTS-only 页面，但事件不同，
指标必须分得开——这正是 §5.4 的要求。

### 5.4 指标必须区分四种事件（裁定原文第 9 条）

| 事件 | 含义 | 不得与谁混淆 |
| --- | --- | --- |
| `missing` | 调用方从未传 `semantic_query_en` | reject |
| reject（按 reason 分档） | 传了但护栏拒绝 | missing |
| embedding failure | 合法英文形式但嵌入不可用 | 上面两者（这是能力失败，要 `degraded`） |
| operator rollback | `semanticDiscovery = false` | 上面三者（这是人为选择） |

四者必须在 `metric_events` / `search_24h` 里可分辨。若现有 schema 已足够，**不得**新增列；
若不足，必须说明缺哪一项，并且 schema 变化要有迁移与测试。

### 5.5 失败分支（先写死）

- G 组任一失败 → 修实现，不修门槛；
- N 组任一失败 → 说明改动越界，必须查清是哪一层碰到了合法路径；
- D 组任一失败 → 本轮引入了降级能力回归，不得发布；
- §5.4 不满足 → 如实报告"缺哪一项"，不得用"两者页面一样"当作可以混淆的理由。

---

## 6. 必须新增的测试

1. 8 种降级情形 × FTS 有命中：`embedCalls = 0`、三个计数为 0、`match_source` 只有 `fts`；
2. 降级 + 零 FTS：返回空且 `embedCalls = 0`；
3. 302 条 / 900 天 ghost 装置：任何降级情形下 ghost 不进页；
4. 显式回滚 + 缺失英文形式：仍 FTS-only；
5. 合法英文形式 + 显式回滚：仍是"有词面锚点才重排"；
6. 合法英文形式 + embedding 抛错 / 超时：FTS-only 且 `onDegrade` 被调用（与 1 的事件区分）；
7. **反向测试**（要求实测输出，不接受声称）：
   - 去掉新的协议短路 → 测试 1 与 3 必须失败；
   - 把短路写成"只在 `ftsCount === 0` 时生效" → 测试 1 与 3 必须失败；
   - 把 `embedCalls` 断言删掉后再恢复短路 → 必须仍能抓到"算了 embedding 但没读向量"的形态
     （即断言不能退化成只看 `comparableVectors`）。

没有反向测试实测输出的新增测试不计入交付。

---

## 7. 交付物

1. 本判据（A0 冻结）；
2. `benchmark/reports/raw-degrade-submission.md`（按方案 §15 模板）；
3. G 组逐情形读数（机器可读）；
4. N 组逐位一致证据（gold 239 + 2,000 条装置 276）；
5. 测试清单与反向测试实测输出；
6. `LEXICAL_ANCHOR_ROLLBACK_POLICY` 的文档更新（裁定第 5 条：登记为**有意的安全修正**）。

---

## 8. 先写下来的已知限制

1. **本轮丢掉 raw-v1 的重排能力**。Phase 1b 的 raw 端到端 MRR 0.769 里有一部分来自它；
   降级请求的排序此后是纯 bm25 + `id` 全序。这是裁定接受的代价，不是缺陷；报告必须写出
   "降级请求的排序会退化"，不得声称无代价。
2. **本轮不改善召回**，一条也没有。它缩小的是误召回暴露面。
3. **`embedCalls` 只能在注入了 embedder 的测试里观测**，生产侧靠 `protocolSemanticEn` 与
   `semanticQueryIssues` 间接反映。报告必须说明这一点，不得声称生产可直接观测 `embedCalls`。
4. **gold 语料无法证明降级路径的泛化**：它 239 条全部带合法英文派生值，所以 N 组是行为中立锁，
   G 组的证据来自专门构造的装置。
5. **本轮不回答 Phase 3C 的 P6**。裁定明确 P6 仍挂起，最终误召回盲审在本轮验收之后。

---

## 9. Provenance

| 项 | 值 |
| --- | --- |
| 判据文件 | 本文件 |
| 冻结口径 | SHA-256 前 16 位，取**本表 checksum / 时间两行填入之前**的正文 |
| 冻结时点 | **先于任何实现改动与任何测量** |
| 上游调查 | `benchmark/reports/raw-degrade-investigation.md`（探针 `benchmark/probe-raw-degrade.ts`） |
| 裁定 | 降级路径 = FTS-only；产品语义 5 条见 §2；硬门槛见 §5 |
| 策略（本轮不得改动） | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false / 默认时间窗无界 |
| 对照基线 | `benchmark/reports/phase3c-identity.json`（gold 239，3C 收口后）、`phase3c-recall.json`（2,000 条装置 276） |
| A0 checksum | `fde489c146c7210e` |
| A0 冻结时间 | `2026-08-07T06:19:31Z` |
