# P2 第 4 步的事实清单（40 条记录的选材，撰写前的准备）

> 判据：`benchmark/reports/safety-round/p2-calibration-criteria.md`（SHA-256
> `dd61359b…0035a1`，已冻结）
>
> 状态：**准备物，不是记录本身**。它存在的理由是第 2 步的实测结论——
> pilot 里 5 条同区域记录有 2 条撞上既有 gold（`p04c×t11` 0.670、`p03c×t08` 0.558），
> 而第 3 步先列了旧 gold 覆盖面再选事实，208 对的最高只有 0.476。
> **差别在顺序**，所以这一步先把 40 条的选材摊开对齐，再动笔。
>
> 本文件不冻结。第 4 步落盘的是 `turns-safety-round.json`，冻结物见判据 §10。

---

## 1. 旧 26 条 gold 的覆盖面（避让清单）

| 区域 | 已被旧 gold 占用的事实 |
| --- | --- |
| FTS / 检索 | t01 FTS5 字面量化、t21 RRF 与 0.2 地板线、t02 embedding 超时降级 FTS-only |
| MCP | t06 入参边界校验与 pin 错误返回、t24 zh/en 的描述与注入 |
| timeline / 隔离 | t20 锚定 source turn、t22 scope_key 硬隔离 |
| ACP | t04 错误日志脱敏、t07 recycle 失败移除死 slot、t08 fallback Observation 集成测试 |
| 安装 / 保活 | t09 purge→clean install 闭环、t13 复制清单漏文件、t14 改用 restart()、t15 diagnose 版本漂移、t16 真实环境验收 |
| 认证 | **t11 本地 token 认证（256-bit + 0600）** |
| hook | t03 AgentSpawn hook 不再重启 Worker |
| 其他 | t05 版本收敛、t10 job 命名、t12 测试目录隔离、t17 端到端验收、t18 bootstrap 索引字节数、t19 故障路径验收、t23 q8 量化 384 维、t25 typecheck 3 个错误、t26 质量基准集发布门 |

**两条被 pilot 裁决禁用的事实**（判据 §5.2，理由见 `p2-near-duplicate-pilot.md` §4）：

- 本地凭据的 32 字节随机 / `0o600`（= t11）
- 压缩失败降级为 `quality=fallback` 且只带确定性证据（= t08）

## 2. 40 条的选材

`s01`–`s08` 已在第 3 步落盘并通过筛查（`p2-sample-records.md`）。`c09`–`c40` 是待撰写的
32 条候选，凑满 40。**"出处已核验"指该数字/断言已在本会话中由 grep 或读文件直接确认。**

### 2.1 检索机制（8 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c09 | decision | 融合只用名次不用分数：`score += weight/(rrfK+rank)`；相似度只用于与 floor 比较和定名次，`semanticScore` 从未进排序 | `src/server/observation-search.ts` 融合两行 + 方案 §3 | ✅ |
| c10 | decision | 候选池是 scope 全量（`Infinity`），只有前 1000 名保留名次；两件事分开表达 | 同上 `:102` / `:111` | ✅ |
| c11 | feature | 策略自检：floor 必须在 `[-1,1]`、cap 必须是非负整数或 `Infinity`、pool 必须 ≥1 或 `Infinity` | 同上 `:317`–`:366` | ✅ |
| c12 | change | 回滚档 `LEXICAL_ANCHOR_ROLLBACK_POLICY`：floor 0.2 / cap `Infinity` / pool 200 / topK `Infinity` | 同上 `:120`–`:133` | ✅ |
| c13 | bugfix | raw 降级路径曾是第三种未校准形态：`discoveryEffective=false` 只拦 `ftsCount===0`，有 1 条 FTS 命中就用英文空间校准的 0.197 打分整个 scope | `raw-degrade-investigation.md` §1 | ✅ |
| c14 | decision | raw-v1 正例 0.080–0.607 与噪声 ≤0.431 重叠，因此该空间没有可辩护阈值 | 同上（第 38 行） | ✅ |
| c15 | discovery | bigram 腿 R2：10 个 arm 可行 0 个，`bigramAux` 保持关闭，不得用"恢复原状"充当阶段成功 | `phase3a-r2-selection.md` 结论节 | ✅ |
| c16 | decision | `days` 上限 3650，默认无界但显式可收窄 | `src/server/mcp-server.ts:360` | ✅ |

### 2.2 误召回与门槛（10 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c17 | discovery | floor 0.197 是在 30-turn 语料上选的：当时单查询语义候选最多 11 条，49 条 empty 平均返回 0.592 | 方案 §2 D1 + `phase2b/arm-f0.197-c2.json` | ✅ |
| c18 | discovery | 同一组参数搬到 5 万条：一次查询平均 16.0%（正例）/ 6.2%（负例）语料过线，最高 48.7% | 方案 §2 D1 | ✅ |
| c19 | discovery | 一个被纠正的误读：`semanticIds` 长度 ~200 不是过线数量，43/56 条 query 的物理行数顶在 `topK=1000` | 方案 §2 D1 的警示块 | ✅ |
| c20 | discovery | floor 0.320 让 foreign-domain 10/10 归零，代价是丢掉最低分正例（0.308） | 方案 §2 D3 | ✅ |
| c21 | discovery | 同一批 floor 下 near-domain 去重后平均只从 1.50 降到 1.15，清不干净 | 方案 §2 D3 | ✅ |
| c22 | discovery | 两套校准集给出相反答案：phase2B 72 条正例 hit@5 50.0%→26.4%，盲审 26 条零代价 | 方案 §2 D4 | ✅ |
| c23 | discovery | 召回收益：hit@5 0%→80.77%，21/26 进 Top-5，0 退化 | `codex-blind-audit-report.md` §3 | ✅ |
| c24 | discovery | 页面替换两套口径：物理行新增 109 / 移除 105，折叠后 55 / 53 | `duplicate-supplement.md` §5 | ✅ |
| c25 | discovery | 5 条未找回正例里 4 条整页被同源副本占满，但去重救不回任何一条（`fra-r09` 名次 641，折叠后 129） | `duplicate-supplement.md` 正例侧一节 | ✅ |
| c26 | decision | `cap=1` 让"平均返回 ≤1"成为算术恒真，因此预登记为诊断臂，与 `cap=0` 同等地位 | `codex-p6-ruling.md` §3 + 方案 §8 | ✅ |

### 2.3 规模与装置（4 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c27 | discovery | 5 万条规模、`K=1000`：p95 158/183/193/216/286ms，p99 338…448ms，RSS +225…+324MB | `topk-submission.md` 第 101 行（K 档位对照表） | ✅ |
| c28 | discovery | `K=200` 在 5 万条档只保留 4,618 条过 floor 候选里的 163 条，有序 `resultIds` 与全量打分差异 0 | `topk-submission.md` 第 108–113 行 | ✅ |
| c29 | discovery | 装置构成：1 万条原文 × 5 副本 = 5 万行，副本复用向量，播种跨度 1095 天 | `codex-blind-audit-freeze.json` `oldCorpus` | ✅ |
| c30 | decision | filler 生成规则：78 个独特 concept + 33 个文件基名禁用表，`lexicalViolations` 0，`uniqueTitles` 10000 | `pool-policy-filler-10k-meta.json` | ✅ |

### 2.4 注入、MCP 与配置（4 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c31 | decision | 注入索引预算 `maxOutputBytes: 8192`，低于 `agentSpawn` 的 10KB 上限 | `src/config.ts:62` + README「Configuration」 | ✅ |
| c32 | decision | MCP 详情响应单字段上限 32KB（`DETAIL_RESPONSE_BYTES`） | `src/server/mcp-server.ts:167` | ✅ |
| c33 | decision | `retrieval.semanticDiscovery` 只改检索：不动 schema、不动存储向量、不动嵌入协议，可来回切换无需重建 | README「Semantic Discovery and Rollback」 | ✅ |
| c34 | discovery | `/health` 的 retrieval 档位每次调用从磁盘读，报告的是**下一个** session 会用的档位 | README 同一节 | ✅ |

### 2.5 排序与后续轮次归属（2 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c35 | discovery | `ORDER BY fts.rank, o.id ASC` 里 `id ASC` 在无界且 id 与插入时间相关的语料上实际编码 oldest-first，不是"不携带排名意见" | `codex-p6-ruling.md` §5 | ✅ |
| c36 | decision | 等 bm25、年龄/长度解耦 fixture 独立成 FTS 排序轮次，可并行取证但必须单独报告和裁定 | 同上 | ✅ |

### 2.6 纪律与轮次边界（4 条）

| id | 类型 | 事实 | 出处 | 核验 |
| --- | --- | --- | --- | :--: |
| c37 | decision | 最终盲审集已消耗：可用于描述性测量，不得用于选 floor / cap / τ | 方案 §4 第 1 条 + `codex-p6-ruling.md` §4 | ✅ |
| c38 | decision | 禁止再试任何"相对语料背景归一化"变体，包括分位数版与 margin-over-median 版 | 方案 §4 第 8 条 + `p40-relative-score-probe.md` §9.1 | ✅ |
| c39 | decision | 结果去重必须在本轮之后单独立项：它同时影响页面可用性与误召回读数，混进来无法归因 | 方案 §12 | ✅ |
| c40 | decision | 网格改为按规则等距铺开（0.197 起约 0.025 步长至 0.325），使没有任何一个值是"被单独指出来的" | 方案 §8 | ✅ |

## 3. 分布检查（撰写前先看，避免结构性混淆）

| 维度 | 现状 | 判据要求 |
| --- | --- | --- |
| `memory_type` | decision 18 / discovery 15 / bugfix 3 / change 3 / feature 2 / refactor 0 | 无硬性要求，但 refactor 为 0 值得补 1–2 条 |
| `fact_source.kind` | `report` 与 `code` 齐全；**`commit` 仍为 0** | §2.2 为 commit 写了规则，见待审点 1 |
| 年龄 / 长度 / 插入序 | 尚未随机化 | §8.8 三者必须独立，见待审点 2 |
| 与旧 gold 的重叠 | 已按 §1 避让；c13 / c14 与 t21 同区域，c16 与 t06 同文件，需重点看筛查读数 | §5 逐对穷举 |

## 4. 仍需完成的准备（进入撰写之前）

40 条的出处**已全部核验**（§2 的核验列无 ⬜）。剩下的三件都依赖 `p2-sample-records.md` §5
的待审点定案：

1. **`commit` 类来源**（待审点 1）：若采纳，需从 `git log` 找出 2–3 条"某行为已被删除"的
   改动（例如四处 `?? 90` 兜底的删除），逐条写清哪项改动支持该事实。
2. **`refactor` 类型补 1–2 条**：当前分布里它是 0。这不是判据要求，是为了让 `memory_type`
   的分布别把某一类完全空掉——`search` 的 `type` 过滤器按它工作。
3. **年龄随机化的种子与脚本**（待审点 2）：一次性生成 40 条的 `age_days`，并报告年龄 vs
   文本长度、年龄 vs 插入序的相关系数。

query 集（110 条）的选材单独列，不在本文件内：它依赖 40 条落盘后的 id，且低分正例那一层
要按判据 §7.2 的"只增不删"程序分轮补写。
