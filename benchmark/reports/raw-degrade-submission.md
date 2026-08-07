# raw-v1 降级路径收口提交：降级 = FTS-only —— **G / N / D 组全过**

> 判据：`benchmark/reports/raw-degrade-criteria.md`，A0 `fde489c146c7210e`，
> 冻结于 `2026-08-07T06:19:31Z`，**先于任何实现改动与任何测量，判据全程未修订**。
>
> 上游调查：`benchmark/reports/raw-degrade-investigation.md`。
> 裁定：**降级路径 = FTS-only，不采用 Phase 1b raw policy。**
>
> 本轮是裁定三步收尾的**第 2 步**。Phase 3C 保持"有条件通过、P6 挂起"；本轮未借用 P6 数据，
> 未调整 floor / cap / Top-K / 候选池 / 时间窗。

---

## 阶段

raw-v1 降级路径收口（方案 §2.3 的落地）。请求验证：**降级语义核验**。

---

## 改动范围

### 行为变化：一句话

`semantic_query_en` 缺失或被护栏拒绝时，**语义腿完全不执行** —— 不生成 query embedding、
不读取任何已存向量、不数 scope 向量数，只返回词面检索结果。该规则**不受 `semanticDiscovery`
开关影响**。

### 生产代码

| 文件 | 改动 |
| --- | --- |
| `src/server/observation-search.ts` | 新增不变量 `semanticLegEligible = protocol === SEMANTIC_EN_PROTOCOL`，包住整个语义腿（含 `countScopeVectors` 与 embedding 两个 try）；`LEXICAL_ANCHOR_ROLLBACK_POLICY` 文档按裁定第 5 条登记"不再逐字段复现 Phase 1b"及理由 |
| `README.md` / `docs/i18n/README.zh.md` | 「独立召回依赖英文形式」改写为「语义检索依赖英文形式」，写明缺失/被拒时**既失去语义召回也失去语义重排**、`raw-v1` 永不打分；回滚章节写明这一条是**故意不恢复**的安全修正 |

实现只有一处判断，刻意写成**不变量而非 policy 字段**：不允许任何 profile 或 benchmark arm
把它打开。位置也是刻意的——它包住两个 `try`，所以 raw-v1 下连 `scopeVectors` 都不数，
`scopeVectors` 保持 `null`（= "语义步骤从未运行"，与 `0` = "scope 里没有向量"是两件事）。

### 测试改动（分两类，必须分清）

| 文件 | 类别 | 改动 |
| --- | --- | --- |
| `tests/integration/raw-degrade.test.ts` | 新增 | 9 条：G1–G7 + N5 + D1/D2/D3 |
| `tests/integration/retrieval-policy.test.ts` | **类别 1（改写断言方向）** | `describe('FTS 有候选时行为中立（Phase 1b 的 raw 重排必须一个字不变）')` → `describe('raw-v1 一律 FTS-only')`；两条 `test.each` 的期望值**反转** |
| `tests/integration/semantic-en-search.test.ts` | **类别 1** | 三条协议隔离测试改写：「只给 raw-v1 打分」→「什么都不打分」；「中文原文被送进模型」→「不生成任何 embedding」；「回落到 raw-v1 打分」→「回落到 FTS-only」 |
| `tests/integration/search.test.ts`、`retrieval-policy.test.ts` 的 `search()` 助手、`tests/db/embedding-versioning.test.ts` | **类别 2（补合法英文形式，保持原意）** | 这些测试测的是 RRF / 平局 / cap / 权重 / 超时降级 / 向量可比性，只是**借 raw-v1 顺手驱动语义腿**。补 `semanticQueryEn` = query 自身（护栏明确允许"英文原样归一"，这些 fixture query 全是英文） |

**类别 1 与类别 2 的区别是本轮最需要说清的一点**：类别 1 把已被裁定为缺陷的行为写成了断言，
必须**反转**；类别 2 只是装置借道，必须**补齐**以保持它原本测的东西。把类别 2 当成类别 1
去删断言，等于借修缺陷之名削弱测试覆盖。

`tests/db/embedding-versioning.test.ts` 里 `a current-model row IS semantically ranked` 那条
额外把向量写入位置从 raw 空间改成**英文空间**——"当前空间"现在指的是语义腿唯一会读的那个。

### 明确未改

`semanticFloor` 0.197 / `semanticOnlyLimit` 2 / `rrfK` 60 / 权重 1:1 / `tieBreak` semantic-rank /
`semanticCandidatePool` Infinity / `semanticTopK` 1000 / 默认时间窗（无界）/ 5 个 bigram 字段
（`bigramAux` 仍 `false`）/ FTS tokenizer / 内部 FTS limit 50 / MCP schema / embedding 模型 /
`semantic-en-v1` 协议与护栏判定规则 / DB schema（**未新增列**，见 §指标 4）。

---

## Provenance

| 项 | 值 |
| --- | --- |
| commit | `13ad15c`，dirty（工作区含 Phase 1b–本轮未提交产物） |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 判据 | A0 `fde489c146c7210e`，冻结于 `2026-08-07T06:19:31Z`，**无修订** |
| 上游调查 | `raw-degrade-investigation.md`（探针 `benchmark/probe-raw-degrade.ts`） |
| 策略（本轮未动） | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false / 时间窗无界 |
| 唯一自变量 | `protocol !== semantic-en-v1` 时语义腿是否执行 |
| 对照基线 | `phase3c-identity.json`（gold 239，3C 收口后）、`phase3c-recall.json`（2,000 条装置 276） |
| 产物 | `raw-degrade-identity.json`、`raw-degrade-recall.json`、`raw-degrade-identity-diff.json` |

---

## 指标

### 1. G 组：降级路径必须是 FTS-only —— 全过

判据 §4 要求覆盖 `checkSemanticEnQuery` 的**全部 8 种**情形（不只裁定点名的四项）：

| # | 门槛 | 读数 |
| --- | --- | --- |
| G1 | 8 种情形 + FTS 有命中：`embedCalls` | **0**（逐情形） |
| G2 | `comparableVectors` / `semanticCount` / `aboveFloorCount` | **0 / 0 / 0**（逐情形）；`scopeVectors` = **null** |
| G3 | 结果 `match_source` | 只有 `fts`；`semantic` / `hybrid` **0 条** |
| G4 | 降级返回 vs 纯 FTS 有序结果 | **逐位相同** |
| G5 | 降级 + 零 FTS | 返回空，`embedCalls` **0** |
| G6 | 302 条 / 900 天 ghost 装置 | ghost **8 种情形下全部不进页** |
| G7 | 显式回滚 + 缺失英文形式 | 仍 FTS-only，`embedCalls` **0** |

8 种情形实测覆盖的 reason：`missing`、`empty`、`placeholder`、`untranslated`（CJK 比例）、
`untranslated`（原样回显）、`lost_tokens`、`too_long`、`length_ratio`。

`embedCalls` 是**注入的计数器**，与 `comparableVectors` 分开断言。理由写进判据 §5.1：
`comparableVectors === 0` 也可能是"算了 embedding 但一条向量都没读到"，那不满足裁定第 1 条。
反向测试 R3 证明这个区分不是多余的（见 §测试）。

### 2. N 组：合法路径行为中立 —— 全过

| # | 门槛 | 读数 |
| --- | --- | --- |
| N1 | gold 239 query 有序 `resultIds` | 差异 **0** |
| N2 | summary 指标 + 17 gate | 差异 0（仅 `latencyP50/P95`）；gate ok 逐条一致，`allGatesOk` 均 true |
| N3 | 逐 query 41 个字段（`semanticRank` / `comparableVectors` / `matchSources` 等） | 差异 **0** |
| N4 | 2,000 条装置 276 query × 16 字段 | 差异 **0** |
| N5 | 合法英文形式 + 显式回滚 | 仍是"有词面锚点才重排"（裁定第 3 条），实测通过 |
| N6 | `bun test` / `typecheck` | **539 pass / 0 fail** / 干净 |

gold 语料 239 条 query 全部带合法英文派生值（gate「query 侧协议一致 239/239，护栏拒绝 0」），
所以 N 组是**行为中立锁**：它证明改动没碰到合法路径，不能用来证明降级路径的泛化。

### 3. D 组：既有降级能力不得回归 —— 全过

| # | 门槛 | 读数 |
| --- | --- | --- |
| D1 | 合法英文形式 + embedding 抛错 | FTS-only，`onDegrade` 被调用，`embedCalls` = **1** |
| D2 | 同上 + FTS 有命中 | 仍返回 FTS 结果（不是空） |
| D3 | 降级路径上 `type` / `days` / `limit` | 逐项生效；跨 scope 泄漏 0（N 组 gate 复核） |

D1 的 `embedCalls = 1` 与 G1 的 `= 0` 是本轮最重要的一对读数：**能力失败**（尝试过、失败了、
报 `degraded`）与**协议不适用**（压根没尝试、不报 `degraded`）产生同样的 FTS-only 页面，
但是两个不同的事件。

### 4. §5.4 四种事件的可分辨性 —— 满足，**未新增列**

| 事件 | 落点 | 可分辨依据 |
| --- | --- | --- |
| `missing` | `metric_events.reject_reason = 'missing'` → `search_24h.semanticQueryIssues.missing` | `mcp-server.ts` 显式把"传了但被拒"与"从未传"分开赋值 |
| reject（按 reason 分档） | 同列，按 `reject_reason` GROUP BY | 枚举有界，不随流量增长 |
| embedding failure | `metric_events.degraded = 1` → `ftsOnly` / `degradeRate` | 只有能力失败会置位 |
| operator rollback | `protocol = 'semantic-en-v1' AND discovery = 0` | 聚合层可精确导出：**`protocolSemanticEn − discoveryEffective`**。合法英文形式下 `discoveryEffective == discoveryRequested`，而 raw-v1 请求的 protocol 不是 `semantic-en-v1`，所以这个差值恰好等于 rollback 请求数 |

判据 §5.4 写明"若现有 schema 已足够，**不得**新增列"。schema 已足够，因此本轮**没有**改 DB
schema、没有新增聚合字段。如实登记一处边界：`search_24h` 没有**专门的** rollback 计数器，
它是由上面那个差值导出的；README 的指标表已有 `protocolSemanticEn` 与 `discoveryEffective`
两项，所以运维侧可算，但不是一眼可见。

---

## 逐 query 变化

- **改善（误召回收窄）**：302 条装置上，8 种降级情形下 ghost 从"进页且标为 `semantic`"变成
  不可达；`comparableVectors` 从 302 变成 0。
- **退化（如实登记）**：降级请求**失去 raw-v1 重排**，排序变成 bm25 + `id` 全序。判据 §8 第 1 条
  预先写死了这一点，这是裁定接受的代价，不是无代价的收窄。本轮没有测量这个退化的幅度——
  gold 语料 239 条全是合法英文形式，装置里没有降级请求的标注排序。
- **不变**：gold 239 条与 2,000 条装置 276 条的返回**逐位不变**。
- **最大退化**：无结果退化（合法路径零差异）。

---

## 测试

```text
bun test          539 pass / 0 fail（48 文件）
bun run typecheck 干净
```

改动前实测 **4 pass / 5 fail**（新测试确实抓到了旧行为）。

反向测试实测输出（判据 §6 第 7 条）：

```text
R1 去掉协议短路（semanticLegEligible 恒真）        → 5 fail
R2 短路写成"只在 ftsCount === 0 时生效"（复刻旧缺陷） → 5 fail
R3 短路只挡向量读取、仍算 embedding                → 5 fail（embedCalls 0 → 2）
复原                                              → 0 fail
```

R3 是判据 §6 第 7 条第三项要的那条：它证明 `embedCalls` 断言**不能**退化成只看
`comparableVectors`。读数是 **2** 而不是 1，原因查清并登记：注入点落在
`countScopeVectors` 那个 `try` 里，`throw` 被它自己的 `catch` 吞掉，执行继续进入第二个 `try`，
于是真正的 embedding 调用也发生了一次。这同时反证了生产短路的位置是对的——它包住两个 `try`。

登记一处**装置修正**：`lost_tokens` 那条初版用 `FTS5` 当受保护 token，实测护栏**放行**
（`FTS5` 不匹配任何受保护形状），协议是 `semantic-en-v1`，那条用例根本没在测降级路径。
改用 `observation_search.ts` 后才真正触发 `lost_tokens`。

---

## 已知限制

1. **降级请求失去 raw-v1 重排**，排序退化为纯 bm25 + `id`。裁定接受，本轮未测量退化幅度。
2. **本轮不改善召回**，一条也没有。它缩小的是误召回暴露面。
3. **`embedCalls` 只能在注入 embedder 的测试里观测**。生产侧靠 `protocolSemanticEn` 与
   `semanticQueryIssues` 间接反映，不能声称生产可直接观测它。
4. **gold 语料无法证明降级路径的泛化**：239 条全带合法英文派生值。G 组证据来自专门构造的
   302 条装置，它证明**机制**，不是泛化的误召回收益。
5. **暴露面的历史成因已登记但未逐轮回测**：`semanticCandidatePool` 与 `semanticTopK` 是两个协议
   共用的单一字段，2B/2C（floor）、候选池轮次（200→20000）、Top-K 轮次（→Infinity）、
   Phase 3C（时间窗）每一轮的门槛都只在英文空间测过。本轮修的是**当前**暴露面，没有回溯重算
   那几轮在降级路径上的历史读数。
6. **本轮不回答 Phase 3C 的 P6**。P6 仍挂起，最终误召回盲审在本轮验收之后。

---

## 请求 Codex 验证

对应：裁定三步收尾的**第 2 步（raw-v1 降级语义核验）**。

冻结的产品语义（判据 §2）已全部实现并有测试钉住：

1. 缺失/被拒 ⟹ 不生成 embedding、不读 raw 向量、只返回词面结果 —— G1/G2/G3；
2. 不受 `semanticDiscovery` 影响 —— G7；
3. 合法英文形式 + 回滚 ⟹ 仍是"有词面锚点才重排" —— N5；
4. 未为 raw 分叉时间窗 —— D3（`days` 在降级路径上正常生效，无分叉代码）；
5. 回滚 profile 不再宣称逐字段复现 Phase 1b —— 代码注释 + README 中英双语已登记为
   **有意的安全修正**。

推荐独立复跑命令：

```bash
# G / N5 / D 组
bun test tests/integration/raw-degrade.test.ts

# 类别 1 改写后的断言方向
bun test tests/integration/retrieval-policy.test.ts tests/integration/semantic-en-search.test.ts

# N 组行为中立
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --fusion --empty-ext \
  --no-heldout --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 \
  --fts-weight=1 --semantic-weight=1 --tie-break=semantic-rank --semantic-candidate-pool=inf \
  --semantic-topk=1000 --bigram-aux=off --json=/tmp/verify-raw-gold.json
bun run benchmark/run-phase3b-scale.ts --pools=full --sizes=0 --json=/tmp/verify-raw-recall.json

# 现状复核（改动后 ghost 应全部不进页）
bun run benchmark/probe-raw-degrade.ts

# 全量
bun test && bun run typecheck
```
