# Phase 3C 阶段二：跨 90 天边界的正面证据 —— **P0–P5 通过，P6 最终不通过**

> **最终裁定（2026-08-07）**：独立盲审 C1 为 `1.900 > 1`，P6 不通过，Phase 3C 不通过。
> 本文件的 P0–P5 正面证据继续有效；2026-08-06 的“有条件挂起”状态已结束。
> 完整签发见 `final-recall/codex-p6-ruling.md`。

> 判据：`benchmark/reports/phase3c-criteria.md`，A0 `366ce756b0d6ebd0`，
> 冻结于 `2026-08-06T12:10:40Z`，**先于任何实现改动与任何测量**。
>
> **裁决（2026-08-06，选项 (c)）**：P0–P5 通过；P6 **有条件挂起**，结论移交第 3 步独立盲审。
> 默认无界时间窗保留，不回滚。裁决同时认定本报告 §4 的证据不足以无条件放行，理由见 §4.4。
> 完整裁决见 `phase3c-submission.md` 顶部。
>
> 这份报告是本轮**唯一的正面证据**。行为中立在 `phase3c-identity.md`，
> 性能在 `phase3c-submission.md` §4。

---

## 1. P0：改动之前，矛盾必须可实测

判据 §6.2 P0 要求先证明问题存在，否则后面所有断言都可能在修一个不存在的东西。

做法是**先写测试、在未改动的代码上跑**（`tests/integration/time-window.test.ts`，
同 scope 记录落在 −1d / −45d / −100d / −400d，另加一条外部 scope 的 −400d）。
改动前实测 **1 pass / 5 fail**：

| 测试 | 改动前 | 说明 |
| --- | :--: | --- |
| P0/P1 bootstrap 与默认 search 可见范围一致 | ❌ | **bootstrap 侧四条断言全部通过**（−100d / −400d 都在注入索引里），在 `line 127` 的默认 `search` 上失败——这就是产品矛盾本身 |
| P2 显式 `days=90` 仍收窄 | ✅ | 收窄能力本来就正常，本轮不该动它 |
| P3 跨 scope 泄漏 0 | ❌ | 失败的是**反向断言**：显式搜外部 scope 时那条 −400d 记录也搜不到，证明挡住它的是时间窗而不是 scope 过滤 |
| P4 type 过滤对 >90 天记录生效 | ❌ | 窗先把记录挡掉了，type 过滤无从生效 |
| P5 语义腿单独召回 >90 天记录 | ❌ | 记录不在候选池里 |
| P5 补充 候选池确实含 >90 天记录 | ❌ | `comparableVectors` 实测 **0**，不是 2 |

`comparableVectors = 0` 是这组里最硬的一条：它说明语义腿**连打分都没发生**，
而不是"打了分但排名不够"。

## 2. P1–P5：改动之后

同一份测试，改动后 **6 pass / 0 fail**。

| # | 门槛 | 读数 | 判定 |
| --- | --- | --- | :--: |
| P1 | 默认 `search` 召回 −100d 与 −400d | 两条都召回；且 bootstrap 可见 id 集合与默认 search 结果集合**逐 id 相同** | ✅ |
| P2 | 显式 `days=90` 仍过滤掉它们 | 仍过滤 | ✅ |
| P3 | 外部 scope 的 −400d 记录（cosine 完美）永不返回 | 不返回；显式搜该 scope 时可见 | ✅ |
| P4 | type 过滤对 >90 天记录生效 | `type=bugfix` 只返回 bugfix 那条 | ✅ |
| P5 | 语义腿单独召回 >90 天记录 | 零词面重叠 + 合法英文形式，−400d 记录以 `match_source: semantic` 返回；`comparableVectors` 0 → **2** | ✅ |

MCP 层单独覆盖（`tests/integration/mcp-server.test.ts` 新增用例，走真实子进程 + JSON-RPC）：
`tools/list` 的 `days` 不再带 `default`；省略 `days` 能召回 400 天前的记录；显式 `days=90`
仍然只返回 1 条。这一层必须单独测——它有自己的兜底和自己的 schema，内核测试看不见。

## 3. 反向测试实测输出（判据 §7 第 6 条）

判据要求实测输出而不是声称。第一轮我写的三条反向测试**全部没能失败**，原因值得留档：
内核在 `observation-search.ts:1096/1241` 处**显式下传 `days`**，所以 db 层的 `?? 兜底`
对生产路径是死代码——我破坏的是路径外的东西。重做后打在真正的决策点上：

```text
R1  内核默认改回 90（observation-search.ts）                    → 5 fail
R2  searchDateThreshold 把无界当成 90 天（阈值助手失效）           → 5 fail
R3  只放宽 FTS 腿、候选池仍夹到 90 天                             → 2 fail（恰好是两条 P5）
R4  MCP 层兜底恢复 90（boundedInteger）                          → 1 fail
R5  MCP schema 恢复 default: 90                                 → 1 fail
复原                                                            → 0 fail
```

R3 的形状正是判据 §7 第 6 条第二项要求的：只改 FTS 腿时，**只有** P5 那两条失败，
其余四条照样通过。这证明 P5 确实隔离了语义腿这条独立路径。

## 4. P6：误召回不变量 —— 读数越界，但**不是时间窗造成的**

### 4.1 先说清楚现有装置为什么不算证据

三个冻结 empty 集（expected-empty 5 条、phase2 empty 49 条、empty-ext 32 条 hard negative）
全部落在 90 天窗内，所以在它们上面放宽窗口**按构造不可能改变任何返回**——阶段一的零差异
已经证明了这一点。gold 语料上的读数保持 `expected-empty 均 1.00 / 坏 2`、`semanticOnlyMax 2`，
那是连续性，不是"三年语料不会灌满空页"的答案。

### 4.2 于是在 50,000 条老语料上跑同一批 query，并且做了对照臂

装置：50,000 条、跨 **1,095 天**、**91.8%（45,890 条）落在旧的 90 天窗之外**。
语料是与全部 query 无关的合成 filler，因此**任何返回都是误召回**，不需要标注。
唯一自变量是时间窗：同一个库、同一批 query、同一个生产策略。

| 集合 | `days=90`（改前） | 无界（改后） | 时间窗的净贡献 |
| --- | --- | --- | --- |
| expected-empty（5） | 均 5.2 / 坏 10；semantic-only 均 1.2 / 最大 2 | 均 5.2 / 坏 10；semantic-only 均 **2.0** / 最大 2 | 返回 **+0.000**；semantic-only 均 +0.800；**0/5** 条 query 的返回条数变化 |
| phase2 empty（49） | 均 3.327 / 坏 10；semantic-only 均 1.122 / 最大 2 | 均 3.347 / 坏 10；semantic-only 均 1.224 / 最大 2 | 返回 **+0.020**；semantic-only 均 +0.102；1/49 条变化 |
| empty-ext（32 hard negative） | 均 3.719 / 坏 10；semantic-only 均 1.156 / 最大 2 | 均 3.813 / 坏 10；semantic-only 均 1.313 / 最大 2 | 返回 **+0.094**；semantic-only 均 +0.157；2/32 条变化 |

三条读数，逐条说明它意味着什么：

1. **绝对返回数越过了判据写的 ≤1 / ≤3，但两条臂几乎相同。** `days=90` 的臂同样是
   均 3.3–5.2 / 坏 10。所以越界来自**这份合成语料本身**（50,000 条 filler、10,000 条
   不同文本各重复 5 份，中文 query 的 trigram 很容易命中），不是时间窗放宽造成的。
2. **`semanticOnlyMax` 在每个集合、每条臂上恒为 2。** cap 这个结构不变量没有被撼动。
3. **时间窗真正推动的是 semantic-only 的均值**（+0.10…+0.80）。expected-empty 那 5 条
   从均 1.2 涨到 **2.0**，也就是它们现在**把 semantic-only 配额填满了**。2C 当时就标注过
   这个集合"没有余量"，这里必须点出来：余量确实用完了，只是没有越过 cap。

### 4.3 这是我的判据写错了，如实登记

判据 §6.2 P6 写的是「empty / hard-negative 平均返回 ≤1、最坏 ≤3」，**没有指明装置**。
`≤1 / ≤3` 这组数字是 **gold 语料（26–30 条真实 Observation）** 校准出来的；我把它套在
50,000 条 filler 语料上，而那份语料从未按这个阈值校准过，两条臂都不满足。

判据 §6.4 为 P6 失败写死的分支是「默认必须退回有窗」。**我不认为应该照字面执行，但也不能
自己改判据**，所以当时把决定权交出去。**裁决已作出：选项 (c)，有条件挂起，默认保留无界。**
裁决采纳的与驳回的分别是：

- **采纳**：不照字面回滚。`days=90` 对照臂本身就以 5.2/10、3.327/10、3.719/10 越界，
  不能把基线已有的问题归因给时间窗；
- **驳回**：不认定"gold 上读数未变"就足以放行。gold 语料**全部位于旧窗口内**，
  它在结构上测不到"放宽窗口是否引入旧记录噪声"，用测不到该风险的装置核销该风险不成立；
- **另外驳回**：下面这条"意图成立"的论证证据不足，理由见 §4.4——`+0.000 / +0.020 / +0.094`
  只统计返回条数，掩盖了 7 条 query 的页面替换。

原始论证保留在此以便对照（其中第二条已被裁决判为证据不足）：

- 判据 §6.2 P6 的意图（"放宽窗口不得把旧的无关记录灌进 empty query"）在对照臂下**成立**：
  返回均值净贡献 +0.000 / +0.020 / +0.094，最坏值不变，cap 不变量成立；
- 在 `≤1 / ≤3` 真正被校准过的装置（gold）上，读数**未变**：均 1.00 / 坏 2。

同时如实指出：这三个 empty 集里没有一条是**针对老语料**标注的 hard negative——它们问的都是
"本项目没做过的事"，而这份 filler 语料本身就不是本项目的记录。所以"三年真实历史会不会
灌满空页"这个问题，本轮给不出泛化答案。它正好是裁定第 3 步（最终误召回门槛复核）
要 Codex 建独立盲审集去回答的那个问题。

机器可读产物：`phase3c/p6-oldcorpus-unbounded.json`、`phase3c/p6-oldcorpus-days90.json`、
`phase3c/p6-attribution.json`（含逐 query 明细）。

**探针第一版有一处装置缺陷，一并登记**：我手挑英文派生值文件，把 expected-empty 的
q19–q24 指到了 `mirror-en-acp-queries.json`（那里面是 relevance 的 q05/q18…），
于是那 5 条与 empty-ext 的 32 条实际是在**没有 `semantic_query_en`** 的情况下跑的
（英文形式覆盖 0/5、0/32），读数因此偏低且 `semanticOnly` 恒为 0。修法是改走
`loadAcpEnFixture()` 这一个合并入口——harness 用的就是它。那一版的产物已作废删除，
上表全部来自修正后的探针（英文形式覆盖 5/5、49/49、32/32）。

### 4.4 裁决认定的证据缺口：净变化 0 掩盖了结果替换

裁决没有接受 §4.2 的"净贡献 ≈ 0 所以安全"这个推论，理由是它只统计**返回条数**。
裁决点出 q21 / q23 的总返回都是 10、semantic-only 却从 0 变成 2 —— 页面组成变了，
条数没变。按裁决复核全部 86 条，这个形状共 **7 条**：

| 集合 | query | `returned`（90 → 无界） | `semanticOnly`（90 → 无界） |
| --- | --- | ---: | ---: |
| expected-empty | q21 | 10 → 10 | 0 → **2** |
| expected-empty | q23 | 10 → 10 | 0 → **2** |
| phase2 empty | f02 | 10 → 10 | 0 → **2** |
| phase2 empty | f07 | 10 → 10 | 0 → **2** |
| empty-ext | n08 | 10 → 10 | 0 → **2** |
| empty-ext | n27 | 10 → 10 | 0 → **2** |
| empty-ext | n29 | 10 → 10 | **2 → 0**（反方向） |

七条全是满页 query，所以新进来的 semantic-only **必然挤掉了**同样数量的原有结果；
n29 的反方向变化说明这不是单调地"多塞两条噪声"，而是页面重组。

缺口的机制原因写清楚：`benchmark/probe-3c-empty-oldcorpus.ts:68` 只记 `returned` 与
`semanticOnly` 两个计数，**没有**记录有序 `resultIds`、逐项 `match_source`、被挤出的结果
及其 semantic score。所以"换掉了什么、换进来的是否更差"本轮回答不了。

补齐口径由第 3 步的独立盲审承担（审计将同时记录有序结果、来源、semantic score、
页面新增与替换，并对照 `days=90`）。**本轮不自行补测**：现在去加一个新指标再自我判定，
等于看到读数之后改判据。

## 5. 复现命令

```bash
# P0（先于实现）/ P1–P5
bun test tests/integration/time-window.test.ts
bun test tests/integration/mcp-server.test.ts

# P6：建老语料装置（跨 1,095 天），再跑两条臂
bun run benchmark/run-pool-perf-recheck.ts --phase=seed --size=50000 --spread-days=1095 \
  --db=/tmp/3c-old-50k.db
bun run benchmark/probe-3c-empty-oldcorpus.ts --db=/tmp/3c-old-50k.db \
  --json=benchmark/reports/phase3c/p6-oldcorpus-unbounded.json
bun run benchmark/probe-3c-empty-oldcorpus.ts --db=/tmp/3c-old-50k.db --days=90 \
  --json=benchmark/reports/phase3c/p6-oldcorpus-days90.json
```
