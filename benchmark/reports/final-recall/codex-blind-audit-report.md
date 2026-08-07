# 最终检索召回独立盲审：执行报告 —— **P6 不通过（Codex 已签发）**

> ## Codex 裁定（2026-08-07）
>
> 冻结判据 C1 实测 `1.900 > 1`，按 §5 的预登记分支，**P6 不通过，Phase 3C 不通过**。
> 补救选择“另开安全策略轮次”，不回滚 90 天；工作分支暂时保持无界，但对外稳定发布继续阻塞。
> 完整裁定见 `codex-p6-ruling.md`。

> 判据：`codex-blind-audit-criteria.md`（SHA-256 `952eddbe…c3e3`，已冻结）
> 冻结记录：`codex-blind-audit-freeze.json`，冻结于 `2026-08-07T08:34:21Z`
>
> **七项冻结 SHA-256 全部校验通过**，runner 启动时逐项校验，不匹配即退出非零。
>
> 本报告是判据 §6 的交付物 3 与 4。**§5 的裁定分支由 Codex 作**，本报告不写"P6 通过 / 不通过"。
> 门槛 A/B/C/D 是预登记的，因此机械计算并如实登记，包括失败项。
>
> 上一轮我跑的是已看过的 86 条旧 empty 集，未校验冻结 SHA、未测旧记录正例收益、未跑 raw 控制。
> 那份读数（`phase3c/timewindow-audit.md`）**不构成**本审计，本报告取代它作为第 3 步的执行证据。

---

## 1. 冻结校验与装置

| 冻结项 | SHA-256 | 校验 |
| --- | --- | :--: |
| `codex-blind-audit-input.json` | `6111697b…eee36` | ✅ |
| `codex-blind-audit-criteria.md` | `952eddbe…c3e3` | ✅ |
| `precheck-final-recall-audit.ts` | `77e5ee30…9ca3` | ✅ |
| `dataset/turns.json` | `aa8f9bed…533e0` | ✅ |
| `dataset/mirror-en-acp-records.json` | `cf44a103…2119` | ✅ |
| `dataset/pool-policy-filler-10k.json` | `bbb3a673…3d41` | ✅ |
| `dataset/pool-policy-filler-10k-meta.json` | `7a023010…2153` | ✅ |

装置按冻结契约建成：26 条 primary gold 全部落在**基准时刻前 400 天**并写入冻结英文派生值的
真实向量；`pool-policy-filler-10k` × 5 份 = 50,000 条，均匀铺在 **1,095 天**内（真实编码
10,000 次，副本复用向量，cosine 分布逐位保留）；scope 向量 **50,026**。
两臂同库、同策略、同 `limit=10`，唯一差别是 `days=90` 与省略 `days`。

策略：discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank /
pool=Infinity / semanticTopK=1000 / bigramAux=false。**未改任何一项。**

---

## 2. 预登记门槛判定

| # | 门槛 | 读数 | 判定 |
| --- | --- | --- | :--: |
| A1 | 26 正例 + 30 负例纯文本预检 `ftsCount=0` | 冻结预检记录 26/26、30/30；**本轮两臂复核：56 条主 query 的 `ftsIds` 全为空** | ✅ |
| A2 | 26 gold 全在 90 天窗外；语料 ≥90% 在窗外 | gold 26/26（400d）；语料窗外 45,893/50,026 = **91.74%** | ✅ |
| A3 | 两臂 degrade=0 / 跨 scope 泄漏=0 / 协议混排=0 | 0 / 0 / 主 query 协议全为 `semantic-en-v1` | ✅ |
| A4 | semantic-only ≤2 且来源均为 `semantic` | cap 越界 **0**；非法来源枚举 **0** | ✅ |
| B1 | 无界 hit@5 与 MRR 均严格 > `days=90` | hit@5 **0% → 80.77%**；MRR **0 → 0.750** | ✅ |
| B2 | 无界至少找回 1 条被窗口挡住的 gold 到 Top-5 | **21 条** | ✅ |
| B3 | 改善与失败逐条登记 | 改善 21 条，**退化 0 条** | ✅ |
| **C1** | **无界 arm 平均返回 ≤1** | **无界 1.900**（`days=90` **1.800**） | ❌ |
| C2 | 无界 arm 单条最坏返回 ≤3 | 无界 **2**（`days=90` 2） | ✅ |
| C3 | 无界 arm `semanticOnlyMax` ≤2 | 无界 **2**（`days=90` 2） | ✅ |
| C4 | 同时报告两臂绝对值与逐页替换 | 见 §4；负例页面变化 29/30 | ✅ |
| D | 8 条 raw 控制在两臂均严格 FTS-only | 两臂 8/8 全过 | ✅ |

---

## 3. B 组：旧记录正例收益（这是此前完全缺失的一半）

26 条 gold 全部在 400 天前，26 条 query 全部零 FTS 候选。因此 `days=90` arm 在结构上不可能
找到任何 gold —— 实测正是如此：

| | `days=90` | 无界 |
| --- | ---: | ---: |
| 触达 gold（进页） | **0 / 26** | **21 / 26** |
| hit@5 | **0.0%** | **80.77%** |
| MRR | **0.000** | **0.750** |
| 退化 | — | **0 条** |

21 条从"结构上不可达"变成 Top-5 命中，0 条退化。这是无界时间窗在**独立盲审集**上的收益证据，
与此前引用候选池轮次读数不同，这份是针对时间窗本身、且构造时未看过任何 arm 返回。

5 条未进 Top-5 的 query（`fra-r05` `fra-r09` `fra-r12` `fra-r18` `fra-r21`）逐条明细在
`codex-blind-audit-result.json` 的 `perQuery.main`。

---

## 4. C 组：C1 失败的机制,以及它不在时间窗上

### 4.1 读数

| | `days=90` | 无界 | 门槛 |
| --- | ---: | ---: | ---: |
| 平均返回 | **1.800** | **1.900** | ≤1 |
| 最坏返回 | 2 | 2 | ≤3 |
| semantic-only 均 | 1.800 | 1.900 | — |
| `semanticOnlyMax` | 2 | 2 | ≤2 |

返回条数分布：

| 返回条数 | `days=90` | 无界 |
| ---: | ---: | ---: |
| 0 | 3 | 1 |
| 1 | 0 | 1 |
| 2 | **27** | **28** |

### 4.2 机制：cap 被填满,而不是窗口灌进噪声

三个事实同时成立：

1. **30 条负例在两臂都是零 FTS 候选**（`ftsIds` 全为空，本轮实测复核，非仅依赖冻结预检）；
2. **两臂返回的全部 111 条结果（54 + 57）来源都是 `semantic`**，没有一条 `fts` 或 `hybrid`；
3. **28/30（无界）与 27/30（`days=90`）把 cap=2 填满**。

所以平均返回 ≈ 2 不是"时间窗换进了旧噪声"，而是**语义腿在每条负例上都能找到 2 条过 floor 的
候选，把配额填满**。返回项的 semantic score 区间 0.211–0.455，全部高于 floor 0.197。

算术上的紧张关系值得写明：cap=2 且 28/30 填满 ⟹ 均值 ≥ 1.867。要让均值 ≤1，**至少需要 15 条
负例返回 0**；当前无界 arm 只有 1 条、`days=90` arm 只有 3 条。

### 4.3 归因：回滚时间窗不能修复 C1

判据 §4.C4 允许两臂净差用于归因（不得用于通过判定）。归因结论：

- 时间窗对 C1 的净贡献是 **+0.100**（1.800 → 1.900）；
- **`days=90` arm 自身就以 1.800 越过 ≤1** —— 即在没有本轮改动的行为下，这个门也不成立；
- 窗口只把 **2 条** query 从 0 推到非 0：`fra-n11`（0→1，score 0.279）与 `fra-n17`（0→2，
  scores 0.391 / 0.211）；
- 无界 arm 返回的 57 条里 **16 条是 gold**（年龄 400d，即项目真实记录），其余是老 filler；
  `days=90` arm 的 54 条返回全部来自 90 天内的 filler（年龄 0–89d）。

因此 §5 的两个失败分支在事实上并不等价：**回滚默认时间窗会把 C1 从 1.900 变成 1.800,仍然
失败**。C1 的决定因素是 `semanticFloor=0.197` 与 `semanticOnlyLimit=2` 这个 2C 工作点，
不是时间窗。

我不据此调整 floor / cap / Top-K / 候选池 / 时间窗（判据 §5 末条禁止），也不提出新阈值。
以上只是把"哪一层导致 C1 失败"这件事测清楚，供裁定在两个分支之间选择。

### 4.4 逐页替换（C4 强制的解释证据）

负例 29/30 页面发生变化。全部主 query（56 条）的聚合：

- 新增 **109** 条、移除 **105** 条、来源变化 **0** 条；
- 新增来源构成：`semantic` **109**；主 query 全部零 FTS，因此不存在 `hybrid` / `fts` 新增；
- 满页时被挤出的记录及其替代项逐条记录在 `perQuery.main[].displacedWhenFull`。

逐 query 的有序双页（含逐项 `match_source`、`semantic_score`、`ftsRank`、`semanticRank`、
记录年龄）、新增 / 移除 / 位次变化 / 来源变化,全部在
`benchmark/reports/final-recall/codex-blind-audit-result.json`。

---

## 5. D 组：raw 降级控制（两臂 8/8）

8 条控制覆盖 `missing` ×2、`placeholder` ×2、`untranslated` ×2、`lost_tokens` ×2，
每条都有**期望的词面 gold**（所以它们不是零 FTS，能验证"FTS 仍然工作"）。

两臂各 8 条，逐条满足：

- `embedCalls = 0`、`comparableVectors = 0`、`semanticCount = 0`、`aboveFloorCount = 0`；
- 结果**逐位等于同 arm 的纯 FTS 查询**；
- 来源只有 `fts`，无 `semantic`、无 `hybrid`。

这独立确认了 raw-v1 FTS-only 边界在**旧语料 + 50,026 条 scope**下也成立，且时间窗放宽
没有从 raw 向量给它带来任何东西。

---

## 6. 交给裁定的事实清单

1. **A / D 全过** ⟹ 判据 §5 第一条分支（实现/仪表未通过）不触发。
2. **B 全过** ⟹ §5 第二条分支（无界历史无确认收益）不触发；收益是 hit@5 0% → 80.77%、
   21 条 gold 找回、0 退化。
3. **C1 失败、C2/C3/C4 通过** ⟹ §5 第三条分支触发。同时登记一项事实：
   **`days=90` arm 也失败（1.800 > 1）**，所以"回滚默认时间窗"这条已登记的补救不会让 C1 通过。
4. C1 的决定因素测得是 `floor=0.197` + `cap=2` 的工作点（28/30 填满配额），不是时间窗；
   时间窗净贡献 +0.100。
5. 判据 §5 末条禁止据本审计调参；若要动 floor/cap，需另一份校准集，本审计只能作为调整后的
   确认集整体重跑，并标注**已被消耗**。

---

## 7. Provenance

| 项 | 值 |
| --- | --- |
| runner | `benchmark/run-codex-final-recall-audit.ts` |
| commit | `13ad15c`，dirty |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 空间键 | `all-MiniLM-L6-v2:q8:384:semantic-en-v1` |
| 装置 | 26 gold @400d + 50,000 filler 铺 1,095 天；scope 向量 50,026 |
| 两臂 | `days=90` / 省略 `days`，同库同策略 `limit=10` |
| 未触碰 | 冻结输入、判据、阈值、时间位置、任何 checksum；任何生产策略值 |
| 机器可读 | `benchmark/reports/final-recall/codex-blind-audit-result.json` |

复现：

```bash
bun run benchmark/run-codex-final-recall-audit.ts
```

启动时自动校验七项冻结 SHA-256；任何不匹配即退出非零，不会产出报告。
