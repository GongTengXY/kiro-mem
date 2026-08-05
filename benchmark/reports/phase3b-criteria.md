# Phase 3B 判据（预登记，冻结于任何数据生成之前）

> 版本 A0。冻结时间见文末 provenance。
>
> 上游：3A-R2 Gate 裁决（`benchmark/reports/phase3a-r2-submission.md` 顶部）——bigram 路线收口，
> 下一步 Phase 3B **只建设和冻结装置，不改生产策略**。
>
> 方案依据：`plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §11。

---

## 1. 本阶段要回答的问题

方案 §11 指出的缺陷是**按一个键截断、按另一个键排序**：

```ts
// src/server/observation-search.ts:948
const recentIds = db.getRecentObservationIds({ scopeKey, type, days, limit: 200 });
const candidateIds = [...new Set([...ftsRankMap.keys(), ...bigramRankMap.keys(), ...recentIds])];
// ↓ 然后才按 cosine 排序
```

候选池按 `turn_stopped_at DESC` 取 200 条，再按 cosine 排名。一条旧但高度相关的 Observation
在**打分之前**就消失了——它不是"分数不够"，而是从未被计算过。当前 30 turn 的基准集测不到这个
形状，因为 30 < 200。

本阶段要拿到两个数字，**不做选参**：

- **收益**：`最近 200` 相对 `全 scope` 损失多少 recall；
- **代价**：全 scope brute-force 的延迟与内存。

## 2. 明确的非目标（禁止项）

以下任一项发生，即判本阶段污染：

1. 修改生产检索策略的**任何既有字段值**（`semanticDiscovery` / `semanticFloor` /
   `semanticOnlyLimit` / `rrfK` / `ftsWeight` / `semanticWeight` / `tieBreak` 及 5 个 bigram 字段）；
2. 重新开启任何 bigram arm。裁决明确「bigram 将来可以复用这份语料，但 Phase 3B 不重新开启」。
   本轮所有 arm 一律 `bigramAux: false`；
3. 引入分页扫描、SQLite 向量扩展或 ANN。**先测全量 brute-force**；超预算也只是如实报告超在
   哪一档，方案选择属于下一轮；
4. 修改 FTS tokenizer、embedding 模型、`semantic-en-v1` 协议、MCP 工具 schema；
5. 修改 90 天默认时间窗（3C 的范围）；
6. 因为本轮 recall 上升就建议改生产默认候选池。本轮**没有**选参环节。

## 3. 装置一：recall-scale

### 3.1 规格

| 项 | 值 |
| --- | --- |
| 总量 | 2,000 条 Observation |
| 标注目标 | 既有 30 条真实记录（26 primary + 4 other scope） |
| 填充 | 1,970 条生成语料 |
| 向量 | 全部 `semantic-en-v1` 真实向量：生产模型 `all-MiniLM-L6-v2:q8:384`，经 `buildObservationSearchText()` 同一 builder |
| 目标位置 | 时间轴**最老端** |
| 填充位置 | 全部比目标新 |
| 时间间隔 | 每条 1 分钟，总跨度约 33 小时，全部落在 90 天窗口内 |

两条必须**实测断言**、不能靠推理的性质：

- **A. 窗口内零目标**：`getRecentObservationIds({ limit: 200 })` 返回的 200 个 id 与 30 条目标 id
  的交集必须为空。这是整个装置成立的前提，断言失败即装置无效。
- **B. 全部目标有向量**：30 条目标在 `semantic-en-v1` 空间键下的向量覆盖必须是 30/30。缺一条就
  会让"召回不到"混入"根本没建向量"这个完全不同的原因。

### 3.2 为什么时间跨度要压缩到 33 小时

这是**故意的隔离**，不是偷懒。真实 2,000 条记录会横跨数月，届时 90 天窗口**也**会滤掉老记录，
于是"召回不到"有两个可能原因，读数无法归因。把全部记录压进 33 小时，`days=90` 对所有记录都为
真，唯一起作用的截断就只剩 `limit: 200`。

代价必须写在结论里：本装置测的是**纯候选池效应**，不是真实工作区的综合效应。与 90 天窗口的
交互是 3C 的对象。

### 3.3 标注目标的来源

复用既有 30 条真实记录及其**既有 ACP 产出的英文派生值**（`mirror-en-acp-records.json`），
**不重新翻译**。理由：重新翻译会引入译文漂移这个新自变量，而本轮的自变量必须只有候选池大小。

查询侧同样复用既有冻结的 query 集与其英文派生值，不新出题。本轮不需要新 query——要测的是
"同一条 query、同一个目标，换候选池大小会不会找到"。

### 3.4 填充语料生成规则（先于生成冻结）

1. 英文，软件工程内容，按**固定主题表**模板生成；
2. 主题表声明与本项目 26 条 Observation 的主题**不相交**：Android UI、游戏引擎渲染、支付清算、
   Kubernetes operator、iOS 构建、数仓 ETL、CSS 布局、蓝牙协议栈、地图瓦片、推荐排序等；
3. **词面规则**：填充文本不得包含本项目 concept 词表中的任何词条。这是可机械检查的词面规则，
   执行时**不查看任何检索结果**；
4. 生成后**只披露不删除**：对每条 relevance query 报告「填充中最高 cosine」与「目标 cosine」。
   若存在填充高于目标的情形，如实登记为已知限制，**不得删除那条填充**。

第 4 条是本阶段最重要的纪律。按检索结果删除填充，等于用结果反向构造装置——那正是
2B §7.3 与 3A-R2 反复守住的边界。

#### 修订 B1（2026-08-04，**先于任何数据生成**）：第 3 条的词面规则改为只禁"独特词"

写第 3 条时我没有先看 concept 词表长什么样。看过之后，字面执行它有两个问题，一个是可行性，
另一个更重要——**它会把读数往乐观方向偏**。

机械切分 113 个 concept（规则本身也是机械的：含空格、含大写、含 `_`/`-`/数字 → 独特词；
其余 → 通用词）得到：

```text
独特词 78 条：ACP | MCP | RRF | FTS5 | SQLite | all-MiniLM-L6-v2 | scope_key | turn_events |
              launchd keepalive | semantic floor line | hybrid search | full-text search |
              context injection | cosine similarity | q8 quantization | …
通用词 35 条：search | job | install | quality | coverage | release | logging | concurrency |
              deadlock | restart | sorting | health | privacy | embedding | fallback |
              timeline | bootstrap | hook | pin | en | zh | …
```

禁掉通用词那 35 个的问题：

- **它保护不了要保护的东西。** 这条规则真正要挡的风险是「某条填充其实是某条目标 query 的合法
  答案」。一条讲 Android RecyclerView 的填充不会因为出现 `search` 就变成"编译器为什么转义引号"
  的合法答案。挡住这个风险靠的是**主题不相交**，词面规则只是抓"模板不小心写进了本项目的题材"
  这类事故——而事故的标志恰恰是独特词，不是 `job`。
- **它会让装置作弊。** 禁掉全部通用词等于强行拉开填充与目标的词面距离，于是误召回压力被人为
  降低，`pool-full` 的噪声读数会**偏好看**。这与 §9.2 已经登记的"填充可能低估真实噪声压力"
  是同向叠加的偏差，不能再自己加一层。

**修订后的第 3 条**：

> 填充文本不得包含
> (a) 78 条独特 concept 中的任何一条（大小写不敏感，子串匹配），
> (b) 本项目 `key_files` 里出现过的任何文件基名。
>
> 通用单词**允许**共享，且这是有意的：共享通用词会**提高**噪声压力，让 §6.2 的误召回读数更严，
> 而不是更松。

(a)(b) 两条都是机械可执行、可复核的，执行时不查看任何检索结果。**修订时点：先于任何语料
生成脚本的第一次运行**——比 R2 的 A2（跑完基线之后）时点更早，本轮尚不存在任何数据。

### 3.5 冻结

语料生成后写出 checksum 并标记 `frozen: true`。冻结后不得因为测量结果回改任何一条。

## 4. 装置二：performance-scale

| 项 | 值 |
| --- | --- |
| 规模 | 10,000 / 50,000 条 |
| 向量 | 随机**单位**向量，384 维，`semantic-en-v1` 空间键 |
| 标注 | 无。只用于延迟与内存 |

为什么必须是单位向量：生产向量都经过 `normalize: true`，`cosineSimilarity()` 直接用点积当
cosine。非单位向量不会报错，但会让分数分布失真，于是 floor 相关的读数变成另一个空间的读数。

## 5. 量具改动（唯一允许的产品代码改动）

`RetrievalPolicy` 新增一个字段：

```ts
semanticCandidatePool: number;   // 默认 200，Infinity = 全 scope
```

默认值 **200**，与当前写死的字面量逐位等价。

### 5.1 行为中立门槛（必须实测，不接受声称）

| 项 | 要求 |
| --- | --- |
| 两个冻结 profile 的既有字段 | 一个不动 |
| 既有 gold benchmark 全集 | 逐 query 返回 id **与顺序**逐条不变 |
| `bun test` | 全通过 |
| `bun run typecheck` | 干净 |

### 5.2 三个历史 grid 驱动同批登记

`run-phase2d-grid.ts` / `run-phase3a-grid.ts` / `run-phase3a-r2-grid.ts` 都有一道守卫：
`BASE_POLICY` 必须与生产策略**逐字段且字段数相等**，`flagsFor` 必须为每个字段找到 CLI 参数。
新增字段会让三个驱动立即抛错。

处理方式：三处同批登记 `semanticCandidatePool: 200` 与 `--semantic-candidate-pool` 映射。

**这不改任何历史读数**：200 正是那些运行实际使用的值。守卫的存在意义恰恰是强制新字段被显式
登记，绕过守卫（例如放宽字段数检查）才是破坏。此项须在报告中披露。

## 6. recall 对比口径

两个 arm，唯一自变量 `semanticCandidatePool`：

| arm | pool | 含义 |
| --- | --- | --- |
| `pool-200` | 200 | 当前发布行为 |
| `pool-full` | `Infinity` | 全 scope brute-force |

其余字段全部取 `DEFAULT_RETRIEVAL_POLICY`（含 `bigramAux: false`）。

### 6.1 收益侧读数

- **语义腿触达率**：目标 id 是否出现在 `semanticRank` 中。这是比 hit@5 更直接的读数——
  它区分"打分了但没排上去"与"从未被打分"；
- hit@5 / MRR / R-precision，按 scope 分层；
- 逐 query 变化：改善 / 退化 / 不变 / 最大退化。

### 6.2 误召回侧读数（3A 的教训，必须同时测）

候选池从 200 扩到 2,000，语义腿要给 **10 倍**的向量打分，噪声进页的机会同样放大。3A 的失败
形状正是"收益真实、误召回越界"，所以两个 arm 必须同时报告：

- empty / hard-negative 集的均值与最坏值；
- semantic-only 返回量，以及 `semanticOnlyMax ≤ min(cap, limit)` 不变量；
- **跨 scope 泄漏必须为 0**（硬门）。口径用 3A-R2 §2.4 修正后的定义：
  「返回了不属于本 query 所搜 scope 的记录」。

### 6.3 本轮不做的事

不选参、不改默认、不给出"应该把 pool 改成多少"的结论。判据只回答代价与收益。

## 7. 性能预算（预登记）

| 指标 | 预算 | 依据 |
| --- | --- | --- |
| search p95 @ 2,000 全量 | < 300ms | 方案 §7.4 既有性能门 |
| search p95 @ 10,000 全量 | < 300ms | 同上 |
| search p95 @ 50,000 全量 | < 300ms | 同上 |
| p50 / p99 | 报告，不设门槛 | 首轮无基线，设门槛等于事后编数字 |
| RSS | 报告峰值与稳态；50,000 档不得单调上涨 | 单调上涨 = 泄漏，与"这个规模就是要这么多内存"是两件事 |

延迟测量口径：同一 query 集连续跑 N 轮取分位数，**排除首轮**（模型冷启动与 SQLite 页缓存预热
不是稳态代价，混进去会把冷启动记成检索延迟）。首轮读数单独报告。

超预算的处理：如实报告超在哪一档、超多少，**不在本轮引入任何新向量基础设施**。

## 8. 本阶段的通过判定

"通过"**不是** "recall 提升"。是以下五项全部成立：

1. 两套装置按 §3 / §4 规则建成并冻结（checksum 落盘）；
2. 量具改动行为中立，且是**实测**的逐条不变（§5.1）；
3. 两个 arm 的收益与误召回读数完整（§6.1 + §6.2），跨 scope 泄漏为 0；
4. 三档规模的 p50/p95/p99 与 RSS 读数完整（§7）；
5. `bun test` 全通过、`bun run typecheck` 干净。

任一项缺失即未通过。**装置不得按测量结果回改**。

## 9. 先写下来的已知限制

写在跑之前，避免事后挑选着说：

1. **recall 差距是构造出来的。** 目标被刻意放在窗口外，"200 窗口召回不到"是设计的必然，不是
   发现。装置量化的是**幅度、代价与副作用**。
2. **填充语料是模板生成的英文**，词面与主题多样性低于真实语料，可能**低估**真实工作区的噪声
   压力。真实工作区里 2,000 条记录彼此主题相关，噪声压力更高。
3. **30 条标注目标全部来自本项目历史语料**，与 fusion 集同源，不构成泛化证据。
4. **时间轴压缩到 33 小时**，与真实分布不同；90 天窗口的交互留给 3C。
5. **performance-scale 用随机向量**，只能测延迟与内存，不能测相关性；随机高维单位向量的 cosine
   分布集中在 0 附近，与真实语料不同，因此 floor 之后的候选数会偏少——这会让 RRF 之后的工作量
   **偏低估**，须在结论里注明。

## 10. Provenance

| 项 | 值 |
| --- | --- |
| 判据文件 | 本文件 |
| 冻结方式 | SHA-256，写入 `phase3b-submission.md` 与各报告 provenance |
| 冻结时点 | **先于**任何语料生成脚本的第一次运行 |
| A0 checksum（§10 填入前的正文） | `fbe229ef7557761b` |
| A0 冻结时间 | `2026-08-04T09:32:22Z` |
| B1 修订 | §3.4 第 3 条改为只禁独特词；时点 = **先于任何数据生成** |
| B1 checksum | 见下 |

A0 的 checksum 是 §10 这两行填入**之前**的正文哈希——判据的自哈希不可能包含自己，所以口径必须
写明。Codex 复核 A0 方式：`git`/备份里取回 B1 之前的版本，删除本节 A0 两行及本段后重算 SHA-256，
须得到 `fbe229ef7557761b`。

B1 之后的正文哈希写在 `phase3b-submission.md` 的 provenance 表里（同一口径：不含本节这几行）。
两个 checksum 都保留，是为了让"修订发生在什么时点"可被独立核对，而不是用一个哈希覆盖历史。

复现命令（本判据冻结时尚未运行任何一条）：

```bash
bun run benchmark/build-phase3b-fixture.ts --stage=full   # 建两套装置 + 断言 + 冻结
bun run benchmark/run-phase3b-scale.ts                    # 两个 arm + 三档性能
```
