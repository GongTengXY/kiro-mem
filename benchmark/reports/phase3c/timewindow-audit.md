# 时间窗双臂审计：`days=90` vs 默认无界，逐页差异 —— **读数报告,不含判定**

> 用途：补齐裁定认定的证据缺口。`probe-3c-empty-oldcorpus.ts` 只记 `returned` 与
> `semanticOnly` 两个计数，于是"总返回不变但页面被替换"看不见。
>
> 执行边界（按裁定）：**纯机械仪表**。未修改任何输入、判据、冻结时间或 checksum；
> **不做通过 / 不通过判定** —— P6 与 V3 检索召回的最终裁定由 Codex 作。
>
> 本报告只回答三个事实问题：换了多少、换进来的是什么、是什么机制换的。

---

## 1. 装置与口径

| 项 | 值 |
| --- | --- |
| 库 | 50,000 条，跨 **1,095 天**，其中 **45,890 条（91.8%）** 落在 `days=90` 之外 |
| 对照臂 | `days=90`（Phase 3C 之前的默认） |
| 处理臂 | 默认无界（Phase 3C 之后） |
| 唯一自变量 | 时间窗。同一个库、同一批 query、同一个生产策略 |
| 输入 | 三个冻结 empty 集，**按冻结状态读取，未改一字**：`queries.json`(5) / `queries-phase2.json`(49) / `queries-empty-ext.json`(32)，共 86 条 |
| 英文派生值 | 走 `loadAcpEnFixture()`，覆盖 **86/86** |
| 逐项记录 | 有序 `resultIds`、`match_source`、`semantic_score`、**`ftsRank`**、**`semanticRank`**、记录年龄 |
| 语料性质 | 与全部 query 无关的合成 filler ⟹ **任何返回都是误召回**，无需标注 |

产物：`benchmark/reports/phase3c/timewindow-audit.json`（含 86 条逐 query 完整双页）。
Runner：`benchmark/run-codex-timewindow-audit.ts`。

---

## 2. 计数口径看到的（复现旧读数）

| 集合 | 返回 均 `90→∞` | 返回 坏 | semantic-only 均 | semantic-only 最大 |
| --- | ---: | ---: | ---: | ---: |
| expected-empty (5) | 5.200 → 5.200 | 10 → 10 | 1.200 → **2.000** | 2 → 2 |
| phase2-empty (49) | 3.327 → 3.347 | 10 → 10 | 1.122 → 1.224 | 2 → 2 |
| empty-ext (32) | 3.719 → 3.813 | 10 → 10 | 1.156 → 1.313 | 2 → 2 |

均值净变化 +0.000 / +0.020 / +0.094，最坏值不变，`semanticOnlyMax` 恒为 2。
**这就是此前唯一可见的那一层。**

---

## 3. 逐页口径看到的（此前完全不可见）

| 集合 | 页面相同 | 页面变化 | 其中"总返回不变但页面变了" |
| --- | ---: | ---: | ---: |
| expected-empty (5) | **0** | **5** | 5（q19 q21 q22 q23 q24） |
| phase2-empty (49) | 15 | **34** | 33 |
| empty-ext (32) | 7 | **25** | 23 |
| **合计 (86)** | **22** | **64** | **61** |

- **新增 306 条，其中 306 条（100%）落在 `days=90` 之外** —— 归因干净，全部由时间窗引入；
- **被挤出 302 条**；
- 新增来源：`semantic` **112** / `hybrid` **98** / `fts` **96**。
  即 **194 条（63%）新增不受 `semanticOnlyLimit` 约束** —— cap 只管 `semantic`；
- 被挤出来源：`semantic` 98 / `hybrid` 113 / `fts` 91；
- 新增记录年龄跨度 97–1094 天；新增的 `semantic` 项 score 区间 0.199–**0.604**。

裁定此前点出 q21 / q23 两条，实测这个形状是 **61 条**。

### 3.1 一条满页替换的完整明细（q21）

`returned 10→10`、`semanticOnly 0→2`、`comparableVectors 4110→50000`，**10 条全换**：

| 位 | `days=90` | | | 无界 | | |
| ---: | --- | ---: | ---: | --- | ---: | ---: |
| | id / 来源 | ftsRank / semRank | score / 年龄 | id / 来源 | ftsRank / semRank | score / 年龄 |
| 1 | #49454 hybrid | 30 / 3 | 0.4411 / 12d | #3844 hybrid | **1** / 3096 | 0.3502 / 1011d |
| 2 | #47309 hybrid | 39 / 16 | 0.4284 / 59d | #3829 hybrid | **2** / 1996 | 0.3846 / 1011d |
| 3 | #47624 hybrid | 20 / 38 | 0.4209 / 52d | #8074 semantic | — / **1** | 0.4563 / 918d |
| 4 | #49094 hybrid | 7 / 73 | 0.4108 / 20d | #6199 hybrid | **3** / 2706 | 0.3669 / 959d |
| 5 | #49499 hybrid | 26 / 35 | 0.4211 / 11d | #18074 semantic | — / **2** | 0.4563 / 699d |
| 6 | #48419 hybrid | 15 / 66 | 0.4128 / 35d | #4099 hybrid | **4** / 2516 | 0.3719 / 1005d |
| 7 | #48869 hybrid | 25 / 57 | 0.4148 / 25d | #8209 hybrid | **5** / 3171 | 0.3425 / 915d |
| 8 | #49769 hybrid | 6 / 135 | 0.3916 / 5d | #7984 hybrid | **6** / 3061 | 0.3522 / 920d |
| 9 | #46214 hybrid | 22 / 64 | 0.4130 / 83d | #64 hybrid | **7** / 3191 | 0.3410 / 1094d |
| 10 | #46934 hybrid | 9 / 123 | 0.3969 / 67d | #124 hybrid | **8** / 3131 | 0.3468 / 1092d |

三件事同时成立，缺一件就会读错：

1. **替换是 FTS 腿驱动的，不是语义腿。** 无界页里 8 条占据 `ftsRank` **1–8**，而它们的
   `semanticRank` 是 1996–3191（极差）。RRF 按**名次**算分，`ftsRank=1` 贡献 `1/61`，
   语义名次三千位贡献 `1/3060` ≈ 0 —— 所以是 FTS 名次把它们顶上来的。
2. **新页的 semantic score 反而更低**（0.341–0.456 vs 旧页 0.392–0.441）。
   "分数更高所以更相关"在这里不成立。
3. **只有 2 条是语义腿带进来的**（#8074 / #18074，`semanticRank` 1 与 2，score 0.4563），
   正好等于 cap。这两条是**真实的**语义 top-1/top-2 候选，此前被窗口挡住。

全体分布也支持同一结论：新增项 `ftsRank` 中位 **6**（min 1 / max 50），被挤出项中位 7；
新增项 `semanticRank` 中位 2，被挤出项中位 3。

---

## 4. 一个必须登记的装置混淆（读数不可直接外推）

**这份装置把"记录年龄"与"bm25 优势"构造性地耦合了。** 实测确认：

- 播种代码 `run-pool-perf-recheck.ts:143`：`title: copy === 0 ? f.title : \`${f.title} [copy ${copy}]\``；
- 50,000 条 = 10,000 条真实文本 × 5 份；**40,000 条带 `[copy N]` 后缀，10,000 条不带**；
- `--spread-days` 按 index 升序铺时间，`copy = floor(i / 10000)`，所以 **copy 0（无后缀）
  恰好就是最旧的 10,000 条**（实测最旧 5 条 id 1–5、标题无后缀；最新 5 条 id 49996–50000）；
- bm25 惩罚长文档，所以**无后缀（最短）的那一批天然 bm25 占优**。

结论：在这份装置里，「最旧」与「bm25 最好」是同一批记录。因此
**"旧记录占据 FTS 名次前列"这个现象的幅度被装置放大了**，不能读成真实语料的性质。

不受这条混淆影响、可以直接采信的部分：

- **306/306 新增全部来自旧窗之外** —— 这是时间窗的定义，与文本长度无关；
- **`semanticOnlyMax` 在三个集、两条臂上恒为 2** —— cap 不变量成立；
- **语义腿带进来的项确实是语义 top-1/top-2**（q21 的 semRank 1 与 2），
  这类新增与副本后缀无关；
- **63% 的新增不受 `semanticOnlyLimit` 约束**（`fts` + `hybrid`）—— 这是结构事实：
  cap 只管 `semantic` 一档。时间窗放宽后，FTS 腿本身的候选面也扩大了。

要把被放大的那部分测准，需要一份**文本各自独立、且年龄与文档长度不相关**的老语料装置。
本轮未建（那会修改输入，超出裁定给的边界）。

---

## 5. 交给裁定的三个待决点（我不作判定）

1. **误召回门槛该按哪个口径判。** 计数口径给出 +0.000/+0.020/+0.094；逐页口径给出
   64/86 页面变化、306 条新增。两者描述同一次改动。
2. **`semanticOnlyLimit=2` 在无界窗口下是否仍是完整护栏。** 实测 63% 的新增走
   `fts` / `hybrid` 两档，不经过 cap。这不是本轮引入的（cap 一直只管 `semantic`），
   但时间窗放宽把这条通道的入口从"最近 90 天"扩到了"全部历史"。
3. **`ORDER BY fts.rank, o.id ASC` 的 `id` 全序键在无界窗口下的含义变了。**
   FTS 修复轮把它登记为"among records the ranker cannot distinguish, the older one wins;
   a stated, arbitrary, stable convention rather than a relevance claim"。窗口有界时
   候选集被限制在近期记录内，这个约定影响很小；窗口无界后它系统性偏向**语料中最旧的记录**。
   本轮的装置无法把这一项与 §4 的混淆分开，因此只登记，不给读数。

---

## 6. Provenance

| 项 | 值 |
| --- | --- |
| runner | `benchmark/run-codex-timewindow-audit.ts` |
| 库 | `/tmp/tw-audit-50k.db`，由 `run-pool-perf-recheck.ts --phase=seed --size=50000 --spread-days=1095` 建 |
| commit | `13ad15c`，dirty |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 策略 | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false |
| 输入（未修改） | `queries.json`、`queries-phase2.json`、`queries-empty-ext.json` 及其英文派生值；三份文件的 sha16 写入 JSON 的 `provenance.inputsUnmodified` |
| 未触碰 | 任何判据文件、任何冻结时间、任何冻结 checksum、任何生产策略值 |

复现：

```bash
bun run benchmark/run-pool-perf-recheck.ts --phase=seed --size=50000 --spread-days=1095 \
  --db=/tmp/tw-audit-50k.db
bun run benchmark/run-codex-timewindow-audit.ts --db=/tmp/tw-audit-50k.db \
  --json=benchmark/reports/phase3c/timewindow-audit.json
```
