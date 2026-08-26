# Phase 2 校准集数据说明（Gate A 交付物）

> 日期：2026-07-31
> 依据：`plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §6.2 第 9 项、§6.4、§7.3
> 数据文件：`benchmark/dataset/queries-phase2.json`
> 产出率与逐条 FTS 读数：`benchmark/reports/phase2-zero-fts-yield.md` / `.json`

## 0. 这份集合是什么、不是什么

**是**：floor × cap 的主校准与选择依据（方案 §7.3 第 2 条）。

**不是**：泛化证据。它由实现者本人按 `turns.json` 标注写成，写的时候已经看过 Phase 1a/1b
的全部结果。它唯一强的地方是这些具体问法从未参与过任何参数选择，且全部 query 在任何
arm 运行之前就已冻结。任何引用这批数字的地方都必须带上这句限定。

它也**不是** `tuned` 的扩充。`origin` 取新值 `phase2`，与既有 18 条 tuned 分开报：
方案 §7.3 第 1 条要求既有 `tuned + empty` 只承担历史连续性锁，混进去会让"与 Phase 1b
逐 query 一致"这个中立性判据失去意义。

## 1. 规模与方案门槛

| 子集 | 条数 | `ftsCount = 0` | 方案要求 |
| --- | ---: | ---: | ---: |
| relevance | 72 | **72（100%）** | ≥ 36 |
| empty | 49 | **49（100%）** | ≥ 30 |
| 合计 | 121 | 121 | — |

覆盖 primary Observation：**26 / 26**，每条被 1–6 条 query 引用。多 expect 的 query 9 条。

## 2. 语言分层

| 子集 | 中文 | 英文 |
| --- | ---: | ---: |
| relevance | 56 | 16 |
| empty | 37 | 12 |

英文 query 的 `semantic_query_en` 就是原文（生产里由发起 search 的 Agent 直接给出，
不走翻译），中文 query 的英文形式在任何 arm 运行前一次性生成并冻结。详见 §6。

## 3. relevance 改写形状分布

方案 §6.2 要求"不能只换掉一个词"，须覆盖多种形状。实际分布：

| 形状 | 中文 | 英文 | 合计 | 含义 |
| --- | ---: | ---: | ---: | --- |
| 因果问法 | 14 | 4 | 18 | 问"为什么会这样"，不问事件本身 |
| 故障表现 | 12 | 5 | 17 | 从用户看到的症状问起，不用实现词汇 |
| 抽象概括 | 13 | 3 | 16 | 只问那条记录的 `learned`，不提具体现象 |
| 实现机制 | 10 | 2 | 12 | 问机制，但用外行说法 |
| 口语改写 | 7 | 2 | 9 | 同一件事的日常说法 |

## 4. empty 类型分布

| 类型 | 中文 | 英文 | 合计 | 说明 |
| --- | ---: | ---: | ---: | --- |
| hard-negative | 28 | 8 | **36** | 技术上相近、本项目确实没做过 |
| 异域 | 9 | 4 | 13 | 与软件工程完全无关 |

hard-negative 是这一集的重点，也是 floor/cap 选择的主要约束来源。它们覆盖两类：

- **邻域技术**：Postgres 连接数、Redis 缓存穿透、Kafka 重平衡、OAuth 登录、GPU 批量推理、
  镜像多阶段构建、分库分表主键、灰度放量。本项目一条都没做过。
- **本项目的已知未做项**：重排模型放哪层、近邻索引内存、跨机同步、Web UI、按时间清理、
  导出、字段级多向量、两字词切分、更大编码器、五万条规模耗时。这些在 README 的
  Limitations 或方案的暂缓项里出现过，但**没有任何 Observation 记录做过它们**——
  它们是最危险的一类误召回：语义上离语料很近，事实上完全不该命中。

## 5. `ftsCount = 0` 是怎么保证的

用 `benchmark/probe-zero-fts.ts` 机械判定，判据只有一条：
`db.searchObservationsFts(query, { scopeKey, days: 90, limit: 50 }).length === 0`，
与 `hybridSearchObservations` 的 FTS 腿口径逐字一致。

**探针不加载模型、不算 cosine、不做融合、不看返回结果**，所以它在物理上无法用于
"按语义名次挑 query"——那正是方案 §6.2 与 Gate A 第 7 条要排除的污染形式。改写循环里
唯一的反馈信号是"哪个 FTS 单元命中了哪条记录"。

### 播种等价性自证

探针自建 FTS 索引，因此必须先证明这份索引与生产一致。`FTS_ORACLE` 收录已提交 Phase 1b
报告里 42 条既有 query 的 FTS 候选数，探针启动时逐条对账，不一致即退出。

实测 **42/42 一致**。参照值取自 `gold-phase1b-semantic-en.md` 与 `gold-phase1b-raw.md`
的「逐 query 分路明细」，两份报告该列**逐条相同**——FTS 腿吃的是原始中文 query，与向量
协议无关，这既是它能当参照的原因，也是一条独立的口径证据。

### 5.1 起草过程中的两个机制性发现

**FTS 是三字窗口子串匹配，不是分词。** 要避开的是 3 字重叠，不是"词"。记录里的
"未闭合引号"含 `合引号`，但 query 里的 `个引号` 不命中。这比"避开同义词"宽松得多，
所以中文第一稿 58 条里 48 条（82.8%）直接达标，3 轮定向改写到全绿。

**英文 zero-FTS 比中文更难。** FTS 把整个空白分隔段当一个单元，于是英文虚词会撞进中文
语料里嵌的英文标识符：`the` → t08、`out` → 5 条、`time` → 4 条、`worker` → 11 条，
另有 `and` `after` `open` `back` `get` `file` `data` `local` `read` `index` `memory`
`sign` `dead` `slot` `embedding` `restart` `compressor` `deadline` `runtime` 同样命中。
英文第一稿 16 条里 11 条命中，远差于中文。

这条对阶段 3A（中文两字词召回）有直接影响：混合语料下英文侧的词面召回其实比中文侧
**更强**而非更弱，所以"FTS 对中文不友好"这个判断只在纯中文 query 上成立。

## 6. 英文派生值（`semantic_query_en`）的生成与冻结

121 条全部有英文形式，**121/121 通过生产护栏 `checkSemanticEnQuery`**。构成：

| 来源 | 条数 | 说明 |
| --- | ---: | --- |
| 真实 ACP 翻译 | 93 | 中文 query，走 `probe-acp-translate.ts --query-set=phase2` |
| 恒等填充 | 28 | 英文 query。护栏原文写明"An English source legitimately normalizes to itself"；生产里英文形式由已在推理中的 Agent 直接给出，不走中→英 prompt。1b 实测那正是失败最集中的形状，所以这批不消耗 ACP 调用 |

### 6.1 ACP 可靠性实测（独立调用，非生产形态）

| 轮次 | 并发 / 超时 | 尝试 | 成功 |
| --- | --- | ---: | ---: |
| 首轮 | 3 / 30s | 98 | 74 |
| 重试 1 | 2 / 45s | 24 | 17 |
| 重试 2 | 1 / 60s | 7 | 2 |
| 重试 3 | 1 / 60s | 5 | **0** |

合计 93 / 98。这个曲线与 1b 的结论一致：**独立翻译调用远不如顺带产出可靠**
（1b 记录记录侧生产形态 30/30 ×3，而独立调用 11/20）。它同时印证了 1b 登记的那条要求：
将来做派生值批量重建时，那条路径必须自带重试与失败队列。

### 6.2 移除的 5 条（必须披露）

重试 3 轮、并发降到 1、超时提到 60s 之后仍**确定性失败**（每轮都是 JSON 解析失败，
不是波动），已从校准集移除：

| id | 类型 | query | 判断 |
| --- | --- | --- | --- |
| y03 | 异域 empty | 红酒配牛排选什么年份 | 离软件工程最远的三条 |
| y08 | 异域 empty | 猫咪掉毛严重要换粮吗 | 同上 |
| y11 | 异域 empty | 咖啡豆浅烘和深烘差别在哪 | 同上 |
| z14 | 隐喻 relevance | 钥匙不在了应该关门还是放人进来 | 需要解码隐喻才能对上 t11 |
| z32 | 隐喻 relevance | 挡在人前面的东西为什么不能干重活 | 需要解码隐喻才能对上 t03 |

失败形状是有信息量的：翻译 prompt 属于 `kiro-mem-compressor`，面向工程记忆文本，
遇到红酒年份或猫粮时模型倾向回一句解释而不是 JSON。**这是 probe 侧现象**——生产里
query 的英文形式由 Agent 直接给出，不走这个 prompt（1b 已登记同一结论）。

对集合的影响必须分开讲，因为两个方向相反：

- 移除 3 条**异域** empty 拿掉的是**最容易**的真负例，剩下的 49 条里 36 条是
  hard-negative，比例从 69% 升到 73%。这个方向是保守的。
- 移除 2 条**隐喻** relevance 拿掉的是最难的两条，所以 relevance 一侧有**乐观偏差**。
  诚实地说，这两条本来也偏离了"用户真会怎么问"——z14 要求把"钥匙"映射到凭据、
  "关门还是放人"映射到 reject vs fail-open。翻译器都读不出来，真实用户也不会这么问。
  但这是移除之后的判断，所以按纪律记为偏差而不是改进。

不为它们手写英文形式：全集 93 条走的是生产译者，手写 5 条会引入译者不一致，
而"两次互不参照的翻译"正是 1b 要控制的变量。

### 6.3 探针的一处缺陷（本轮发现并已修）

首轮"成功"的 93 条里有 2 条（z05 / z34）ACP 返回的是字面 `...`。JSON 合法、字符串非空，
于是探针记成 ✓ 并写进固定输入——但生产 `checkSemanticEnQuery` 会以 `placeholder` 拒绝，
那条 query 在 arm 里会**静默落回 raw-v1**。探针的成功计数因此高估了可用译文数，
而高估的那部分恰好是会污染实验的部分。

已加固：`probe-acp-translate.ts` 的 query 解析改成过一遍生产护栏，不通过即走既有的
重试与失败队列。两条重译后通过。这个缺陷是靠"冻结前跑一遍全量护栏校验"发现的，
所以那一步现在是冻结流程的一部分，不是可选检查。

## 7. 标注纪律

- 标注依据只有 `turns.json` 的 annotation 事实，没有任何一条依据检索返回结果。
- `expect` 取"直接有帮助"的记录。9 条多 expect 全部是两条记录各自覆盖同一问题的不同侧面，
  与既有 q03（"hook 超时会不会拖慢启动" → `[t03, t19]`）的房规一致：
  t09/t12（都不碰真实目录）、t09/t16（卸净重装无残留）、t03/t19（hook 静默失败的策略与实测耗时）、
  t04/t19（脱敏规则与隐私扫描结果）、t18/t22（跨 workspace 的字节观测与隔离机制）。
- empty 的 `expect` 一律为空，且 `kind` 显式声明——不靠 `expect.length === 0` 推断，
  因为 leakage 类的 `expect` 也是空的但含义不同（`dataset.ts` 记录了这个错误）。

## 8. 已知限制

| 项 | 状态 |
| --- | --- |
| 标注独立性 | 弱。同一人、同一份语料、已看过 1a/1b 结果 |
| 语料规模 | 26 条 primary Observation。72 条 relevance 摊到 26 条记录（每条被 1–6 条引用），单条记录的排序变化会同时影响多条 query |
| empty 的真负性 | 靠"语料里没有这件事"论证，不是靠第三方标注 |
| 英文层 | 16 + 12 条，且英文 query 打的是中文语料（双语用户场景）。英文用户的真实场景是英文语料对英文 query，本集合测不到 |
| relevance 侧乐观偏差 | 移除的 2 条隐喻式 query 是最难的两条，见 §6.2 |
| 译者一致性 | 93 条中文走真实 ACP，28 条英文恒等填充。两者不是同一个"译者"，虽然恒等是护栏明确允许的形式 |
| 与 Codex 审计集的关系 | 本集合是 Kiro 选参用的校准集。方案 §7.9 第 8 条要求 Codex 另建独立审计集，本文件不替代它 |

## 9. 复现

```bash
# zero-FTS 判定 + 播种等价性自证
bun run benchmark/probe-zero-fts.ts \
  --candidates=benchmark/dataset/queries-phase2.json \
  --report=benchmark/reports/phase2-zero-fts-yield.md \
  --json=benchmark/reports/phase2-zero-fts-yield.json

# 英文派生值（一次性，走真实 ACP；三轮重试见 §6.1）
bun run benchmark/probe-acp-translate.ts --target=queries --query-set=phase2 \
  --out=benchmark/dataset/mirror-en-acp-queries-phase2.json

# 冻结前必跑：121 条英文形式逐条过生产护栏
bun -e "
const { checkSemanticEnQuery } = await import('./src/semantic-en');
const qs = JSON.parse(await Bun.file('benchmark/dataset/queries-phase2.json').text());
const mir = JSON.parse(await Bun.file('benchmark/dataset/mirror-en-acp-queries-phase2.json').text());
let ok = 0; for (const q of qs) if (checkSemanticEnQuery(mir.queries[q.id], q.query).ok) ok++;
console.log(ok, '/', qs.length);
"
```

## 10. Checksum

| 文件 | sha256（前 12 位） |
| --- | --- |
| `benchmark/dataset/queries-phase2.json` | `908efa997041` |
| `benchmark/dataset/mirror-en-acp-queries-phase2.json` | `8aa7109144d0` |
| `benchmark/probe-zero-fts.ts` | `9dd736696b52` |
