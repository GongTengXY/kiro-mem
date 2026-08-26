# 候选池策略轮次：G5 / G-STEP 判据冲突裁定请求

> 提交时间：2026-08-05。请求的是**裁定**，不是验收——本轮尚未完成，裁定前我不动选择脚本、
> 不跑成本 arm、不改生产默认值。
>
> 上游：Phase 3B 验收裁决第 5/6 条（独立候选池策略轮次）。判据预登记于
> `benchmark/reports/pool-policy-criteria.md`，**A0 冻结于任何 arm 运行之前**
> （`2026-08-05T06:01:11Z`，正文哈希 `b62d31533d4f2465`）。

---

## 1. 一句话

6 个召回 arm 已跑完，产品读数是一个大幅收益且零 gold 退化；但**判据里两条门槛按字面失败，
根因是判据自身两节互相矛盾（我写错了对象），不是产品行为异常**。修正后的形式已机械验证、
0 条无法归因。请裁定采用哪一条处置路径。

---

## 2. 已运行的内容与行为中性凭据

量具改动（`benchmark/run-phase3b-scale.ts`，唯一改动的文件）：

- `--pools=` / `--perf-pools=` / `--json=` 参数化，**默认值等于 3B 口径**（`pools=200,full`、
  `perf-pools=full`、`rounds=4`），不带参数运行仍复现 3B；
- 新增逐 query 记录：`resultSources`（每条返回的 `match_source`）、`ftsIds`（FTS 候选集）、
  `degradedCount`、`rssLoop`（检索循环内 RSS 归因）、`samples`（丢首轮后样本数）；
- `measureLatencyLoop` 抽成共享 helper，按池循环，**同一 seeded DB**；
- `bun run typecheck` 干净。

**行为中性凭据**：`pool-200` 与 `pool-full` 的全部读数与 3B 逐位相同
（68/190·35.8%·36.8%·0.361·empty 3.56/10·cmpVec 210；152/190·80.0%·65.8%·0.617·
empty 3.80/10·cmpVec 1989）。量具只增加了记录项。

判据 §4 的三条探针**先于 A0 冻结**，已在判据内逐条留档，其中一条是本轮的关键前置发现：
SQLite 绑定参数上限 65,535（uint16 回绕），`getObservationEmbeddingsByIds` 绑定 `ids+2`，
故候选 id > 65,533 时抛错并被检索内核 `catch` 吞成 `onDegrade` + FTS-only（静默失去语义
召回）。今天池是 200 不可达；选 ∞ 会使其可达。

---

## 3. 六个 arm 的读数（2,000 条 3B 冻结装置，checksum 校验通过）

| arm | 触达 gold | hit@5 | MRR | phase2（n=72，全零 FTS） | fusion hit@5 / MRR | empty 均/坏 | semantic-only 均/max | 可比向量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pool-200 | 68/190 35.8% | 36.8% | 0.361 | **0 · 0.0%** | 58.1% / 0.565 | 3.56 / 10 | 0.86 / 2 | 210 |
| pool-500 | 68/190 35.8% | 36.8% | 0.361 | 0 · 0.0% | 58.1% / 0.566 | 3.66 / 10 | 0.99 / 2 | 507 |
| pool-1000 | 68/190 35.8% | 36.8% | 0.361 | 0 · 0.0% | 58.1% / 0.567 | 3.67 / 10 | 1.01 / 2 | 1003 |
| pool-1970 | 68/190 35.8% | 37.4% | 0.362 | 0 · 0.0% | 59.7% / 0.569 | 3.67 / 10 | 1.02 / 2 | 1964 |
| pool-1971 | 71/190 37.4% | 38.9% | 0.378 | 3 · 4.2% | 59.7% / 0.569 | 3.69 / 10 | 1.03 / 2 | 1965 |
| **pool-full** | **152/190 80.0%** | **65.8%** | **0.617** | **43 · 31.9%** | **80.6% / 0.751** | 3.80 / 10 | 1.15 / 2 | 1989 |

位移（相对 pool-200 逐 query 比对，全部 276 条 query）：

| arm | gold 掉出 top-5 | gold 掉出整页 | gold 进入 top-5 |
| --- | ---: | ---: | ---: |
| pool-500 / 1000 | 0 | 0 | 0 |
| pool-1970 | 0 | 0 | 1 |
| pool-1971 | 0 | 0 | 4 |
| pool-full | **0** | **0** | **55** |

已通过的门槛：G1 泄漏 0；G2 `semanticOnlyMax` = 2；G4 degrade 0（全部 arm）；
G8 empty 均值 3.80 ≤ 4.06；G10 semantic-only 均值 1.15 ≤ 1.36 且 max 2；
G7 净收益为正（55 改善 / 0 退化）。

---

## 4. 冲突一：G5 按字面失败

**判据原文**：「S1 结构界：`results(arm) \ results(pool-200)` 中每条的 `match_source`
100% 为 `semantic`；违反 0 条」（硬门）。

**实测**（pool-full）：新进页 416 条 = `semantic` 388 + **`hybrid` 22 + `fts` 6**。
按字面即 28 条违反。中间池同形状：500 → 11 条、1000 → 23 条、1970/1971 → 28 条。

**根因是判据自相矛盾，不是产品行为**：

- 判据 §4.2（S1）证明的是**新候选**没有词面证据，所以只能以 `semantic` 进页；
- 判据 §4.3（S2）在同一份文件里预测了**既有候选**的语义名次会弱变差、RRF 分会弱下降，
  因此**页面成员会重排**；
- G5 却把 S1 的结论写成覆盖「新**进页**者」。一条本来就是 FTS 候选、只是没挤进前 10 的记录，
  在别人分数掉得更多时会升上来——这正是 S2，判据自己预测过。

**修正后的形式，已机械验证（0 条无法归因）**：

```text
pool-full：非 semantic 的新进页者 28 条 → 28/28 在 pool-200 时就已在 ftsRank 候选集内
           无法归因（既不是 semantic、也不是既有 FTS 候选）：0 条
           semantic 新进页者 > 2 条的 query 数：0（全部 arm，cap=2 生效）
pool-500/1000/1970/1971：同样 0 条无法归因
```

即：扩池新增的候选**只能**以 `semantic` 进页并受 cap 约束（S1 成立）；页面成员的其余变化
**全部**是既有 FTS 候选被融合重排（S2 成立），且在本装置上**没有让任何一条 gold 退化**。

---

## 5. 冲突二：G-STEP 按字面失败

**判据原文**：「`pool-500` / `pool-1000` / `pool-1970` 的 relevance 读数与 `pool-200`
**逐位相同**；`pool-1971` 恰好触达 1 条目标」。

**实测**：

- 触达数**确实恒为 68**（500 / 1000 / 1970 全部），步进函数在「触达」口径上精确成立；
- 但 hit@5 在 1970 是 **37.4%**（vs 36.8%），fusion MRR 0.565 → 0.566 / 0.567 / 0.569；
- `pool-1971` 触达 **71**（+3 条 query），因为新纳入的那 1 条目标是 3 条 query 的 gold；
  目标级仍是 +1。

**根因同上**：「逐位相同」这个措辞把"未被打分"（触达，池的直接作用）与"排名结果"
（受 S2 重排影响）混为一谈。判据 §1.1 论证的对象是前者，写门槛时写成了后者。

---

## 6. 请裁定的三个选项

| 选项 | 内容 | 代价 |
| --- | --- | --- |
| **1** | 按字面执行：G5 硬门失败 → `pool-full` 不可行 → 保持 200 | 一个 hit@5 +29pt、phase2 从 0% 到 31.9%、零 gold 退化的结果，死在我写错的一句话上；而真正的安全性质（新候选受 cap 约束、无无法归因的进页者）实测成立 |
| **2** | 修订 G5 / G-STEP 为 §4 / §5 的已验证形式，如实披露为**结果后修订、且是纠正而非收紧**，继续本轮 | 预登记强度下降到与修复轮 B1 同级（修订发生在看完全部 arm 之后）；须在提交报告中明示，不得再表述为"全程未修改的预登记实验" |
| **3** | 作废本轮读数，改完判据重新冻结再重跑 | 装置与实现都没动，重跑数字会一模一样，而我已看过数据——这个选项买到的是形式，不是盲度 |

我的建议是**选项 2**，并接受两条附加约束：修订文本必须写成可机械复算的形式（§4 那三行断言）；
提交报告的正式表述改为「含一次结果后判据修订的实验」。

若裁定选项 2，修订后的门槛拟为：

> **G5'**（硬门）：`results(arm) \ results(pool-200)` 中每条必须满足二者之一——
> (a) `match_source === 'semantic'`，且该 query 的 semantic 新进页数 ≤ `semanticOnlyLimit`；
> (b) 该 id 在 `pool-200` 的 `ftsRank` 候选集内（即已是候选，本次仅被融合重排）。
> 两者都不满足的记录数必须为 0。
>
> **G6'**（硬门，替代原 G6 的口径）：任何 arm 不得让 gold 掉出 top-5 或掉出整页；
> 出现即须逐条归因，无法归因到 S1 / S2 即判结构性意外。
>
> **G-STEP'**：`pool-500` / `pool-1000` / `pool-1970` 的**语义腿触达数**与 `pool-200` 相同；
> `pool-1971` 恰好多触达 **1 条目标**。排名类指标（hit@5 / MRR）允许变化，因为 S2 预测了重排。

---

## 7. 裁定后才会做的事（现在未做）

1. 成本 arm：10,000 / 50,000 档 × pools 200 / 5000 / 20000 / full，`rounds=11`（≥200 样本），
   出 p50/p95/p99、循环内 RSS 归因、degrade 计数；
2. 诊断 arm `perf-floor-worst`（floor=−1，测过 floor 候选的排序上界）；
3. 确定性选择脚本 `select-pool-arm.ts`（按判据 §6/§7 机械计算）；
4. G0：30 条语料全量 benchmark 逐位相同（池在 30 条语料上不可能起作用）；
5. 若选中 ∞：`getObservationEmbeddingsByIds` 分块（块 8,192）作为**强制前置条件**，
   含 70,000 候选的边界测试与反向测试实测失败；
6. 冻结后确认集：heldout / validation（污染已披露）、Codex 2B 盲审集；
7. 请求 Codex 在 2,000 条装置上另建盲审集——`heldout` / `validation` 的端点读数在 3B 已公开，
   我手里没有干净的泛化集。

---

## 8. 独立复算命令

```bash
# 6 个召回 arm（约 3 分钟，写 benchmark/reports/pool-policy/recall.json）
bun run benchmark/run-phase3b-scale.ts --pools=200,500,1000,1970,1971,full --sizes=0 \
  --json=benchmark/reports/pool-policy/recall.json

# 判据 A0 复算：删除 provenance 表里 A0 checksum / A0 冻结时间两行后取 SHA-256 前 16 位
# 须得到 b62d31533d4f2465

# 冲突证据复算（新进页标签分布 + 是否已是 FTS 候选 + gold 位移）
bun -e '
const j=JSON.parse(await Bun.file("benchmark/reports/pool-policy/recall.json").text());
const pq=j.perQuery, B=new Map(pq["pool-200"].map(r=>[r.id,r]));
for (const [arm,rows] of Object.entries(pq)) { if(arm==="pool-200") continue;
  let sem=0,non=0,wasCand=0,unexplained=0,over=0,lost5=0,lostPage=0,gain5=0;
  for (const r of rows) { const b=B.get(r.id); if(!b) continue;
    const before=new Set(b.resultIds), baseFts=new Set(b.ftsIds); let s=0;
    r.resultIds.forEach((id,i)=>{ if(before.has(id)) return;
      if(r.resultSources[i]==="semantic"){sem++;s++;return;} non++;
      if(baseFts.has(id)) wasCand++; else unexplained++; });
    if(s>2) over++;
    if(r.kind==="relevance"&&r.expect.length){
      const w=b.goldRank!==null&&b.goldRank<=5, i5=r.goldRank!==null&&r.goldRank<=5;
      if(w&&!i5) lost5++; if(!w&&i5) gain5++; if(b.goldRank!==null&&r.goldRank===null) lostPage++; } }
  console.log(arm,{sem,non,wasCand,unexplained,semOver2:over,lost5,lostPage,gain5}); }'
```

**Provenance**：commit `b2e972f`，dirty（工作区含 Phase 1b–本轮未提交产物，按裁定保留为验收
证据）；Bun 1.2.20 / darwin-arm64；3B 冻结装置 filler `10b572bd3ec7e4b9`、meta `frozen: true`
（checksum 校验通过）；起点生产策略 discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 /
tieBreak=semantic-rank / **pool=200** / bigramAux=false。
