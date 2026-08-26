# 安全策略轮次 P2：新校准集判据

> 日期：2026-08-11（**修订 r3**）
>
> 状态：**已冻结**（r3）。r2 曾冻结于 SHA-256 `dd61359b…0035a1`；r3 的 SHA 见
> `p2-calibration-freeze.json` 的 `criteriaSha256`。
>
> 上游：
>
> - `plan/V3/retrieval-safety-round-plan-2026-08-10.md` §7（P2 的组成与纪律）
> - `benchmark/reports/final-recall/codex-p6-ruling.md` §4（裁定对新校准集的要求）
> - `benchmark/reports/safety-round/p40-relative-score-probe.md`（P4 已作废，本轮收敛为 floor × cap）

### 修订记录

#### r2 → r3（2026-08-11，**由复审裁定授权**，在任何 arm 之前）

**授权来源必须说清**：本文 §1 写着"冻结之后不得修订。发现判据本身有错，只能作废整轮重开"。
r3 是**复审裁定明确要求的修正**，它推翻了这条自我约束——授权来自复审，不来自作者。
复审同时裁定核心数据基本合格、不需要重写 40 条记录与 131 条 query，因此不作废整轮。

| 复审判定 | r2 的错误 | r3 的处置 |
| --- | --- | --- |
| **阻塞①** near-domain 实际没有数量限制 | r2 把 N2 写成"平均 ≤ 该 arm 的 cap"并另设只报告的 N4。`cap=2` 时每条 near-domain 返回 2 条不相关语义结果仍可通过——**正好保留了上一轮失败的形状** | N2 恢复为 **`distinctContent` 平均 ≤ 1**；**删除 N4**。做不到就如实判本轮没有安全 arm，不得因当前参数达不到而取消门槛 |
| **阻塞②** `cap=1` 未在冻结判据里排除 | 上游方案 §8 与裁定 §3 都写了它只能是诊断臂，但 r2 的判据与冻结 JSON 都没有这条 | §4.5 新增小节：`cap=1` 与 `cap=0` 同为诊断臂，选择脚本必须在结构上排除 `cap ≤ 1` |

**N4 那个放宽是作者在 r2 里自行加入的**，不是上游要求。它以"实测不可达"为由取消了唯一的
数量门，而正确的做法是保留门槛、如实报不通过——"当前参数达不到"是结论，不是改判据的理由。

r3 是**收紧**：删掉唯一的放宽项，补上一条缺失的排除项。它不改动任何数据、标注、gold
或 query，因此不触发重新洗牌，也不影响已完成的零 FTS 与低分正例验证。

#### r1 → r2（2026-08-11，冻结前）

补了三个会让本轮无法收口的缺口。三处都是**在产出任何记录、任何 query、任何 arm 读数之前**
改的，因此不违反"看过读数不得改判据"。

| 缺口 | r1 的问题 | r2 的处置 |
| --- | --- | --- |
| D3 的误召回门拆分 | 上游方案 §7.4 要求"在冻结判据时把误召回门拆开"，且"必须在跑第一个 arm 之前定"。r1 全文没有 near / foreign domain 的任何字样，负例也没有可分层的字段——门拆不开，或只能事后补标（那就是看过读数再改判据） | 新增 §4.5：负例必须携带 `negative_type`，并预登记两个门的形状 |
| 低分正例无法合法产出 | §7.1 要求"必须有一批语义得分落在 0.20–0.31"，而 §8.4 禁止依据 cosine 增删 query。两条直接冲突，且"一批"没有数量 | 新增 §7.2：量化为 ≥8 条，并写死"只允许补写、不允许删除"的程序 |
| `ftsCount=0` 没有语料口径 | 零 FTS 是相对语料成立的事实。r1 未指定在哪份语料上确认，同一条 query 在 40 条新记录上是零 FTS，在 5 万条装置上可能不是 | 新增 §4.6：把确认语料与装置组成一起写死 |

---

## 1. 本文管什么

管四件事，缺一不可：

1. 新 gold 语料 `benchmark/dataset/turns-safety-round.json` 的**性质、schema 与事实核验规则**；
2. query 集的 **gold 标注规则**（`primary_gold` / `acceptable_gold`）与 **hard-negative 的定义**；
3. 新旧记录的**重叠检查流程**，以及明确禁止的做法；
4. **误召回门的形状**（§4.5 的 F1 / N1–N3，以及 `cap ≤ 1` 的排除）。上游方案 §7.4 要求它在跑第一个 arm 之前定死，
   而它依赖负例的分层字段，所以只能与数据一起冻结。

冻结之后不得修订。发现判据本身有错，只能作废整轮重开，不得在看过任何读数后改判据。

### 1.1 为什么需要新语料（一句话背景）

`benchmark/dataset/turns.json` 只有 30 条，26 条 `primary` **已全部**被最终盲审用作 gold
（实测：未被用作 gold 的 primary 记录 0 条）。裁定要求"从未作为 gold 使用的独立事实记录"，
因此必须扩展语料。这也是本轮最大的证据薄弱点：整个 V3 检索优化史都只测过这 26 条真实记录。

---

## 2. 新语料的性质：重建 fixture，不是真实捕获

`turns-safety-round.json` 的正式名称是 **"基于真实产物重建的 gold fixture"**。

**不得**在任何报告、代码注释或对外文档中把它称为真实捕获的对话、真实会话记录或生产数据。

每条 turn 必须携带：

```json
{
  "id": "s01",
  "scope": "primary",
  "session": "safety-round",
  "source_mode": "evidence_reconstructed",
  "gold_only": true,
  "fact_source": [
    { "kind": "report", "path": "benchmark/reports/...", "section": "§2" },
    { "kind": "code",   "path": "src/server/observation-search.ts", "symbol": "semanticLegEligible" },
    { "kind": "commit", "sha": "b1df06f", "supports": "该 commit 删除了 raw 协议下的语义腿调用" }
  ],
  "prompt": "...",
  "assistant_response": "...",
  "events": [ ... ],
  "annotation": { ... }
}
```

### 2.1 gold-only 限制（必须写进冻结记录）

- `prompt`、`assistant_response`、`events` 是**为满足 fixture 结构而重建的**，不是历史原文。
  仓库内不存在这些工作的对话记录，`events` 在既有 `turns.json` 中本来也已经是手写的极简结构。
- **本语料不得用于 ACP 压缩质量评估**，也不得用于任何依赖 `prompt` / `assistant_response`
  真实性的实验（压缩保真度、fallback 质量、`assistant_response` 抽取等）。
- Observation 与向量**只从 `annotation` 生成**。这一点已核实：`benchmark/dataset.ts` 的
  `annotationToResult` 只读 `annotation` 的字段，`prompt` / `assistant_response` 不进
  Observation 行，也不进向量与 FTS 文本。
- 每条 `annotation` 的事实**必须能由 `fact_source` 独立核验**。核验不通过的候选不得进入正式集。

### 2.2 `fact_source` 规则

| `kind` | 必填字段 | 要求 |
| --- | --- | --- |
| `report` | `path`、`section` | 章节必须真实存在且确实陈述该事实 |
| `code` | `path`、`symbol` 或 `line` | 必须指向当前代码或明确标注为已删除的历史状态 |
| `commit` | `sha`、**`supports`** | **只写 SHA 不够**，必须说明该 commit 中**哪项改动**支持该事实 |

一条 annotation 至少一个 `fact_source`；`memory_type` 为 `decision` 的至少两个
（决策的依据与决策的落地通常不在同一处产物里）。

`annotation` 里的每个数字（测试通过数、延迟、条数、比例）都必须在某个 `fact_source` 中可查到。
写不出出处的数字必须删掉，不得约等于、不得凭记忆。

---

## 3. gold 标注规则：`primary_gold` 与 `acceptable_gold`

### 3.1 字段定义

```json
{
  "id": "sr-r01",
  "kind": "relevance",
  "query": "...",
  "semantic_query_en": "...",
  "primary_gold": ["s17"],
  "acceptable_gold": ["s17", "t21"],
  "annotation_basis": "..."
}
```

- **`primary_gold`**：本轮从未当过 gold 的**新记录**。本轮 recall **必须用它计算**。
- **`acceptable_gold`**：所有能合理回答该 query 的记录，**包含**旧 26 条中符合条件的。
  `primary_gold` 必须是 `acceptable_gold` 的子集。

### 3.2 为什么必须拆成两个字段

若只有一个多 gold 列表，一条 query **只召回旧 `t21`、完全没找到新记录**也会被算成命中，
而本轮的目的正是验证那 40 条新记录可被找回。合并计分会把这个目的抹掉。

### 3.3 必须分别报告的三套读数

| 读数 | 定义 |
| --- | --- |
| **primary hit@5 / MRR** | 只认 `primary_gold`。这是本轮的主指标 |
| **acceptable hit@5 / MRR** | 认 `acceptable_gold` 全集。用于说明"页面是否有用" |
| **非 acceptable 返回数** | 页面上不在 `acceptable_gold` 里的记录数。均值与最坏值 |

三套必须同时出现在每个 arm 的报告里。只报其中一套的报告视为不完整。

`acceptable_gold` 是**冻结前**穷举的。冻结之后不得以"这条其实也算相关"为由把某条返回项
移出"非 acceptable"计数——那等于看过读数再改标注。想说某条也能回答，必须在冻结前写进
`acceptable_gold`。

### 3.4 多 gold 是默认检查方向

`acceptable_gold` 只有一条时，必须在 `annotation_basis` 里说明**为什么只有这一条能回答**。
理由必须针对事实，不得写"余弦最高""检索只返回了它"——后者是把检索结果带进标注。

实测依据：26 条旧 gold 横跨安装器、ACP、检索、i18n、版本、认证、隔离等全部子系统，
任何关于本项目的新记录都会贴到其中几条，所以"related"是常态而非例外。

### 3.5 计入 40 条的条件

只有 `primary_gold` **非空**的 relevance query 才计入裁定要求的 40 条。
`primary_gold` 为空（只有旧记录能回答）的 query 可以保留，但单独归入 `legacy-only-relevance`
桶，不占 40 条的额度。

---

## 4. Hard-negative 的定义（本轮唯一口径）

### 4.1 相关性判定

> **如果某条 Observation 能实质性地确认、否定或解释 query 所问的事实，它就是相关记录，
> 不能把该 query 标成 expected-empty。**

推论：**"能回答没有"的记录算相关。**

### 4.2 三分类

| 类别 | 定义 | 预期 | gold |
| --- | --- | --- | --- |
| **empty hard-negative** | 没有任何记录能确认、否定或解释这件事 | 返回空 | 无 |
| **negative-answer relevance** | 项目确实没有实现，但有记录明确**讨论过、拒绝过或登记过"未实现"** | 返回那些记录 | 标为 gold |
| **stale-state relevance** | 以前有现在没有，或以前没有现在有 | 返回变更记录 | 变更记录标为 gold |

后两类是 **relevance**，不是 hard-negative。把它们标成 expected-empty 会把正确召回算成误召回。

### 4.3 已裁定的一个具体例子

"search 默认只查最近 90 天，这个限制现在还在吗？" —— 属于 **stale-state relevance**，
**不是** hard-negative。项目历史上真的有过 90 天默认窗口，phase 3C 正是改这个行为，
所以语料里存在能回答它的记录。

### 4.4 词面锚点 hard-negative（30 条）的额外严格性

除满足 §4.1 的 empty 条件外，还要求：

- 词面重叠**只能是偶然的**，不得是问题主题本身；
- 语料里**不存在**能确认、否定或解释该问题的记录。

这比零 FTS 负例更难构造，严格性是必要的：否则正常召回会被误算成噪声。
每条必须写明"哪个词造成词面命中"以及"为什么没有记录能回答"。

### 4.5 负例必须分层，误召回门按层拆开（r2 新增）

上游方案 §7.4 要求在冻结判据时处理 D3：C1 现在对"技术相近但没做过"和"完全异域"用同一个
"平均 ≤1"，而实测这两类的可达性差一个量级。这里把它落成数据字段和预登记的门形状。

#### 字段（硬性）

每条 hard-negative（含 §4.4 的词面锚点那 30 条）必须携带：

```json
{ "negative_type": "near-domain" | "foreign-domain", "negative_type_basis": "..." }
```

- `near-domain`：问的是本项目**确实工作过的技术区域**里一件没做过的事
  （例：检索层没做过的某个具体机制）。
- `foreign-domain`：问的是本项目**整个技术版图之外**的事（例：本项目从不涉及的领域）。
- `negative_type_basis` 必须写明归类理由，且只能引用事实（"该区域有/没有记录"），
  不得引用余弦、rank 或任何检索返回。

字段名沿用最终盲审的既有写法（`codex-blind-audit-input.json` 的 `negative_type`，
取值 `near-domain` / `foreign-domain`，计数已登记在 `codex-blind-audit-freeze.json`
的 `counts.hardNegativeNearDomain` = 20 / `hardNegativeForeignDomain` = 10），
这样两轮的负例可以逐层对齐。

#### 数量下限

§7.1 的 40 条 empty hard-negative 中，`foreign-domain` **不得少于 12 条**；
30 条词面锚点 hard-negative 中，`foreign-domain` **不得少于 8 条**。
理由：foreign-domain 是唯一有硬门槛的那一层（见下），样本太少会让"归零"变成偶然。

#### 预登记的两个门（本轮的误召回门形状，冻结）

| 门 | 层 | 判据 | 口径 |
| --- | --- | --- | --- |
| **F1** | foreign-domain | **逐条返回数必须为 0**，因此均值 0.000 | `physicalRows` 与 `distinctContent` 两套都必须为 0 |
| **N1** | near-domain | 返回项**必须 100% 带 `match_source: "semantic"`** | 出现 `fts` / `hybrid` 即失败 |
| **N2** | near-domain | **`distinctContent` 平均返回必须 ≤ 1** | 与 C1 同量级的数量门；两套口径都要报，判定用 `distinctContent` |
| **N3** | 全体 relevance | 非 acceptable 结果排在 `primary_gold` 之前的次数 **必须为 0** | 这是"不得压过真命中"的可测形式 |

**N2 是 near-domain 的有效数量门，不得替换成"只报告不判定"。** r2 曾把它写成"平均 ≤ 该 arm
的 cap"并另设一个只报告的 N4，那是错的：`cap=2` 时每条 near-domain 返回 2 条不相关的语义结果
仍然算通过，而那恰好就是上一轮失败的形状（C1 实测 1.900，去重后 1.300）。一个门槛如果允许
失败形状原样通过，它就不是门槛。

**若当前参数达不到 N2，如实判"本轮没有安全 arm"**（上游禁止清单第 9 条），
**不得因为达不到而取消或放宽这个门**。方案 D3 的实测（near-domain 去重后在 floor 0.197→0.320
之间只从 1.50 降到 1.15）说明这很可能就是本轮的结局——那也是一个结论，而且是有信息量的结论：
它说明 floor × cap 这两个变量不足以约束 near-domain，需要另开轮次，而不是把门槛改宽。

`distinctContent` 与 `physicalRows` 两套口径都必须报告（P1 已在审计 runner 中实现）。
判定用 `distinctContent`：它是真实的不同假线索数量，`physicalRows` 会被语料里的重复内容抬高。

#### `cap=1` 与 `cap=0` 是诊断臂，不得作为成功候选

上游裁定 §3 与方案 §8 都已写明，这里在冻结判据里落地：

- 零 FTS 的 hard-negative 页面**完全由 semantic-only 构成**，因此 `cap=1` 让"平均返回 ≤ 1"
  成为**算术恒真**——它与检索质量无关，什么都证明不了；
- `cap=1` 与 `cap=0` 同等地位：**只作诊断基线**，用于读出"关掉/压到底之后收益损失多少"，
  **不得进入成功候选集**；
- 因此 P3 的成功候选只能出自 `semanticOnlyLimit = 2`（以及更大的值，若网格包含）。
  选择脚本必须在结构上排除 `cap ≤ 1`，而不是靠人记得。

#### 若 F1 / N2 与低分正例召回不可同时满足

如实报"本轮不通过"（上游禁止清单第 9 条）。不得下调 F1 或 N2、也不得删掉低分正例那一层。

### 4.6 `ftsCount=0` 的确认语料（r2 新增）

零 FTS 是**相对语料**成立的事实：同一条 query 在 40 条新记录上没有词面命中，在 5 万条装置上
可能有。因此确认口径必须与 P3 实际播种的语料一致，否则 §7.1 的"零 FTS 40 条"不可核验。

本轮确认语料就是 P3 装置，组成在此冻结：

| 成分 | 内容 | 出处 / SHA 登记处 |
| --- | --- | --- |
| 新 gold | `benchmark/dataset/turns-safety-round.json` 的 40 条 | 第 4 步冻结 |
| 旧 primary | `benchmark/dataset/turns.json` 的 26 条 `scope: primary` | `codex-blind-audit-freeze.json` `factSources[0]` |
| filler | `benchmark/dataset/pool-policy-filler-10k.json`，10,000 条原文 × 5 副本 | 同上 `oldCorpus` |

旧 26 条**必须**播种：`acceptable_gold` 按 §3.1 允许包含旧记录，不播种就无法计算
acceptable 读数，也无法验证"只召回旧记录、没找到新记录"这个正是本轮要排除的失败模式。

若 P3 实际装置与此不同（例如换 filler 规模），必须**重新确认**全部零 FTS 声明，
并在该 arm 的报告里登记差异。不得沿用旧的 `ftsCount=0` 结论。

---

## 5. 重叠检查流程

### 5.1 三层

| 层 | 判据 | 处置 | 本轮启用 |
| --- | --- | --- | :--: |
| 1 硬重复 | 同 `turn_id`，或文本逐字相同 | 只保留一份 | ✅ 确定性判断，不用余弦 |
| 2 人工复核带 | 新记录 × 26 条旧 gold 的余弦 **> 0.450** | 标记 `overlap-review`，按 `fact_source` 人工裁决 | ✅ 仅筛查 |
| 3 余弦自动删除 | — | — | ❌ **本轮不启用** |

### 5.2 第 2 层的裁决规则（按事实来源，不按余弦）

```text
同一事实 / 同一修复 / 同一结果   → duplicate，删除一个
同一领域但不同工作               → related，保留
能共同回答同一 query             → 加入 acceptable_gold
```

**事实来源比余弦更适合做最终裁决。** 余弦只决定"哪几十对需要人看"，不决定去留。

### 5.3 为什么 0.450 是复核带起点，以及为什么不能自动删除

实测（26 条旧 gold 两两 325 对，同一项目不同工作）：

```
min -0.072   p50 0.246   p90 0.384   p95 0.450   p99 0.545   max 0.614
```

与另外两个已知分布对比：

| 类别 | 范围 | 中位 |
| --- | --- | ---: |
| 记录×记录：同项目不同工作 | −0.072 … **0.614** | 0.246 |
| query→正确答案（审计 21 条命中） | 0.308 … 0.674 | 0.440 |
| query→假线索（审计 57 条负例返回） | 0.211 … 0.537 | 0.337 |
| 记录×记录：逐字复制（filler 副本） | **1.000** | 1.000 |

因此：

- `0.8` / `0.9` 这类阈值**永远不会触发**——除逐字复制外没有任何东西到得了 0.8；
- 任何低到能抓住重复的值（约 0.6）都**压在真实不同工作的上界 0.614 之下**，一开就删真东西；
- `0.614 … 1.000` 之间**没有任何已知样本**，而"同一事实的改写"正落在这一段。

规模上也不需要自动化：40 条新记录 × 26 条旧记录 = **1,040 对**，按 p95 进入复核的量级是几十对，
人工按 `fact_source` 判得完。

### 5.4 冻结口径

`0.450` 这个复核带起点、以及"本轮不启用自动删除"，都在本文冻结。
**不得**在看过实际余弦分布后临时调整复核带。

本检查不看检索结果、不看任何 arm 的返回，因此不属于"用结果反向选 query"。

---

## 6. 近重复 pilot 的定位

产出 4–5 组"同一事实改写" vs "同区域不同工作"，用途限定为：

- 验证 embedding 对近重复的表现；
- 判断未来**有没有可能**建立自动筛查。

**不得**作为本轮自动删除阈值的充分证据。4–5 组样本量太小：

- 若两个分布重叠 → 直接登记"不能自动化"，本轮结束；
- 即使暂时分开 → 只能作为初步结果，**不得冻结为生产阈值**。

---

## 7. 分批冻结顺序

| 步 | 内容 | 冻结物 |
| --- | --- | --- |
| 1 | **本判据** | 本文 SHA-256 |
| 2 | 近重复 pilot（4–5 组） | pilot 数据 + 报告 |
| 3 | 8–10 条新记录样本 | 供审 annotation 与 `fact_source` 写法，**不冻结** |
| 4 | 扩到 40 条记录 + 110 条 query | 数据 + 英文派生值 + 全部 checksum |
| 5 | 硬重复检查 + `> 0.450` 人工复核 | 复核记录（逐对裁决与理由） |

第 3 步口径未通过前不得进入第 4 步。第 4 步冻结完成前不得跑 P3 的任何 arm。

### 7.1 query 集组成（第 4 步填满）

| 类别 | 数量下限 | 备注 |
| --- | ---: | --- |
| relevance（`primary_gold` 非空） | 40 | 其中必须有一批语义得分落在 **0.20–0.31**（低分正例），分层报告 |
| empty hard-negative（零 FTS） | 40 | §4.2 第 1 类 |
| 词面锚点 hard-negative | 30 | §4.4 |
| negative-answer relevance | 记录数量即可 | §4.2 第 2 类，单独报告 |
| stale-state relevance | 记录数量即可 | §4.2 第 3 类，单独报告 |
| `legacy-only-relevance` | 记录数量即可 | §3.5，不占 40 条额度 |

低分正例是**分布要求**而非独立类别：没有这一层，会选出"看起来免费、实际砍掉难查询"的门槛
（实测依据：phase 2B 的 72 条正例上 floor 0.275 让 hit@5 从 50.0% 掉到 26.4%，
而盲审那 26 条正例得分全部 ≥0.308，同一个 floor 对它零代价）。

### 7.2 低分正例怎么合法产出（r2 新增）

r1 只写了"必须有一批"，同时 §8.4 禁止依据 cosine 增删 query。两条冲突：要保证 0.20–0.31
这一层非空，就必须先量出余弦再动手。这里把它变成一个**方向受限**的程序。

#### 量化

**≥8 条** relevance query 的「query→自己 `primary_gold` 的最高余弦」落在 `[0.200, 0.310)`。
分层报告按 `[<0.200) / [0.200,0.310) / [0.310,0.400) / [≥0.400)` 四档给出计数与 hit@5。

上界 0.310 取自实测：最终盲审 26 条正例的最低得分是 0.308，即整个已消耗集**没有一条**
落在这一档以下。这也正是 D4 的坑——门槛看起来免费只是因为集合里没有难样本。

#### 程序：只允许补写，不允许删除

```text
1. 按"间接问法"规则成批撰写 relevance query（不看任何余弦）
2. 一次性测量 query→primary_gold 余弦，按四档分层计数
3. 若 [0.200,0.310) 不足 8 条 → 回到 1，继续补写更间接的问法
4. 重复直到达标。**已写入的 query 一律保留**
```

第 4 步是这个程序合法的全部原因：

- 被量出来的是「query 与它**自己**的 gold」的成对属性，用来控制**难度**，
  不是在判断"哪条记录与这条 query 相关"——gold 早在撰写时按 §3 的事实规则定好了；
- 只增不删意味着这项测量**只能让集合更难**。它无法抬高 hit@5，也无法把一条系统答不好的
  query 藏起来——那才是 §8.4 真正要防的事（"留下系统恰好答得好的 query"）。

因此明确允许的和明确禁止的是：

| 动作 | 允许 | 理由 |
| --- | :--: | --- |
| 测量 query→`primary_gold` 余弦并分层报告 | ✅ | 难度分层 |
| 因 0.20–0.31 层不足而**补写**更间接的问法 | ✅ | 只让集合更难 |
| 因某条得分**太高**而删除它 | ❌ | 方向可疑，且丢掉容易样本会抬高门槛的表观代价 |
| 因某条得分**太低**（<0.200）而删除它 | ❌ | 那是最难的样本，删了正好复现 D4 |
| 因余弦而更改 `primary_gold` / `acceptable_gold` | ❌ | §8.4 |
| 用**检索返回页面**（rank / 命中与否）增删 query | ❌ | §8.4，本程序一次都不跑检索 |

#### 必须留痕

冻结记录里写出：补写轮数、每轮的四档计数、每轮新增 query 的 id 区间。
"只增不删"因此可由 id 区间与逐轮计数核验——任一轮的总数下降即违规。

#### 一个已知的诚实边界

低于 0.200 的正例可能出现，且它们在任何候选 floor 下都会被砍掉。这不是缺陷，是必须被看见的
代价：报告要单独给出 `[<0.200)` 这一档，并说明这一档在所有 arm 上都为 0 召回。

---

## 8. 禁止清单

1. 不得把本语料称为真实捕获的对话或生产数据。
2. 不得用本语料做 ACP 压缩质量评估。
3. 不得使用最终盲审集（`codex-blind-audit-input.json`）的任何 query。
4. 不得根据语义 rank、cosine 或检索返回增删 query，或据此选择 gold。
   两个已登记的例外，都只涉及词面/难度事实，不涉及相关性判断：
   - 可以用 FTS 执行确认 `ftsCount=0`（语料口径见 §4.6）；
   - 可以按 §7.2 的**只增不删**程序测量 query→自己 `primary_gold` 的余弦并据此**补写**。
     删除、更改 gold、以及任何依据检索返回页面的动作仍然全禁。
5. 不得启用余弦自动删除。
6. 不得在看过任何 arm 读数后修改本判据。
7. 不得写出 `fact_source` 无法核验的数字。
8. 年龄、文本长度、插入顺序必须独立随机，不得重现"最旧记录恰好最短"的混淆。
9. 单 gold 必须写明事实理由，不得以检索结果为由。
10. 不得因为等待一个目前无法可靠确定的自动阈值而阻塞 P2。
11. 不得事后补标 `negative_type`。分层必须在冻结时完成（§4.5）。
12. 不得因为 F1 与低分正例召回冲突就下调 F1 或删掉低分正例那一层；如实报本轮不通过。

---

## 9. 实现侧的已知改动点

现有 harness 的 query schema 只有 `gold: string[]`（见
`benchmark/reports/final-recall/codex-blind-audit-input.json`）。P3 的 runner 必须：

- 读 `primary_gold` / `acceptable_gold` 两个字段；
- 分别计算 §3.3 的三套读数；
- 对旧格式（只有 `gold`）保持兼容，用于历史连续性锁；
- 按 `negative_type` 分层，分别判定 §4.5 的 F1 与 N1–N3（r2 新增，r3 收紧 N2 并删除 N4）；
- 在结构上排除 `semanticOnlyLimit ≤ 1` 进入成功候选集（r3 新增）；
- 按 §7.2 的四档输出低分正例分层的计数与 hit@5（r2 新增）。

同时误召回读数必须**同时**输出 `physicalRows` 与 `distinctContent` 两套口径
（P1 已在审计 runner 中实现，见 `final-recall/duplicate-supplement.md`）。

---

## 10. 冻结记录格式

冻结按 §7 分步进行，因此 `p2-calibration-freeze.json` 也是**分步写入**的：
第 1 步只写判据本身，`steps[1]` 之后逐步补齐，全部写满时 `frozen` 置为 `true`。

```json
{
  "frozen": true,
  "frozenAt": "...",
  "criteria": "benchmark/reports/safety-round/p2-calibration-criteria.md",
  "criteriaSha256": "...",
  "criteriaRevision": "r2",
  "turns": { "path": "benchmark/dataset/turns-safety-round.json", "sha256": "...", "records": 40 },
  "queries": {
    "path": "...", "sha256": "...",
    "counts": {
      "relevance": 40, "emptyHardNegative": 40, "lexicalAnchorHardNegative": 30,
      "emptyForeignDomain": 12, "lexicalAnchorForeignDomain": 8
    },
    "lowScorePositiveBands": { "<0.200": 0, "0.200-0.310": 8, "0.310-0.400": 0, ">=0.400": 0 },
    "lowScorePositiveRounds": [ { "round": 1, "addedIds": "...", "bands": { } } ]
  },
  "semanticEn": { "path": "...", "sha256": "...", "translator": "..." },
  "overlapReview": { "path": "...", "sha256": "...", "band": 0.45, "autoDeleteEnabled": false },
  "gates": { "F1": "...", "N1": "...", "N2": "...", "N3": "..." },
  "diagnosticOnlyArms": { "semanticOnlyLimit": [0, 1], "reason": "算术恒真，不得作为成功候选" },
  "ftsZeroCorpus": { "newGold": "...", "oldPrimary": "...", "filler": "...", "copies": 5 },
  "goldOnly": true,
  "forbiddenAfterFreeze": [ "..." ]
}
```

英文派生值（记录的 `semantic_text_en`、query 的 `semantic_query_en`）必须在**第一个 arm 之前**
一次性生成并冻结，附生成脚本与 prompt 的 checksum。
