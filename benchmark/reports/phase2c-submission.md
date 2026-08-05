# Phase 2C 提交：冻结独立语义召回为生产默认 + 灰度开关与运行观测

## 阶段

Phase 2C（方案 §8）。上游：Codex Gate B **通过**
（`benchmark/reports/phase2b-codex-gate-b-decision.md`），选定
`discovery=on / floor=0.197（严格 >）/ cap=2`，其余参数不动。

Gate B 决议要求 2C 同时交付五项，逐项落点如下：

| Gate B 要求 | 落点 |
| --- | --- |
| 1. 把 `0.197 / 2` 写进正式默认策略 | `DEFAULT_RETRIEVAL_POLICY`（`src/server/observation-search.ts`） |
| 2. 用正式灰度开关替代 2B 验证缝 | `config.json` 的 `retrieval.semanticDiscovery`；`KIRO_MEM_SEMANTIC_DISCOVERY` 环境变量缝已删除 |
| 3. 提供显式关键词门回滚 profile | `LEXICAL_ANCHOR_ROLLBACK_POLICY` + `resolveRetrievalPolicy(bool)` |
| 4. 记录 discovery requested/effective、degraded、semantic-only 量与分数段 | `metric_events` 新增 7 列 + `search_24h` 聚合 + `/health` + `kiro-mem diagnose` |
| 5. 特别监控既有 expected-empty 平均 `1.00`（无余量）与审计集 3 条低分假阳性 | 见「已知限制」与 `semanticOnlyMax` / `zeroFts*` 运行指标；门槛注释已改成"紧的" |

## Gate C 第一轮整改（Codex 反馈 4 项）

Gate C 第一轮**未通过**。四项逐条整改与验证如下。

### P1-1 探针没有真正隔离用户库

**问题**：`probe-agent-search-coverage.ts` 静态 `import { createApp } from '../src/server/worker'`。
`worker.ts` 顶层就构造生产单例（`loadConfig()` + `new MemoryDB()`），ESM 在脚本第一行代码
执行之前跑完它，于是真实 `~/.kiro-mem/kiro-mem.db` 被打开并迁移——"只用临时目录"这句
provenance 不成立。`bun test` 靠 `tests/support/preload.ts` 提前改掉 dataDir 才没踩到，
benchmark 脚本没有那层保护。

**整改**：探针**完全不导入** `worker.ts`。Worker 按生产方式以子进程启动
（`bun run src/server/worker.ts` + 隔离 `KIRO_MEMORY_DATA_DIR`），并在临时 dataDir 里按
install 布局写下 `kiro-runtime`（compressor agent + prompt + sessions），因为
`startWorker()` 会先跑 `checkRuntimeHome()`。临时 config 还把 `worker.port` 换成一个借到的
空闲端口——默认 37778 正是用户真实 Worker 占的端口。

**验证**（不是推断）：运行前后 `stat` 真实库三个文件的 mtime/size：

```text
before/after 完全一致：
kiro-mem.db     mtime=1785511257 size=761856
kiro-mem.db-shm mtime=1785236371 size=32768
kiro-mem.db-wal mtime=1785515529 size=403792
→ diff 为空："real DB 未被触碰"
```

报告 provenance 现在写出 `workerImportedInProbe: false` 与 Worker 的启动方式与端口。

### P1-2 探针失败却退出码 0

**问题**：探针失败时不生成报告，进程仍返回 0——因为 `worker.ts` 顶层注册的
`process.on('uncaughtException')` 只 `logError` 就吞掉了顶层异常。

**整改**：两层。(a) 不再导入 `worker.ts`，那个处理器不会被装进探针进程；(b) 探针自己管
退出码：`die()` 打印原因、清理临时目录、`exit(1)`；播种、Worker 启动、ACP 会话各自捕获；
**采到 0 条 search 指标也算失败**（一个"没测到任何东西"的探针不能长得像通过）；报告落盘后
再校验文件存在。同时把 `Bun.serve` 从探针进程里彻底去掉，Codex 复现的"多次 embedding 之后
`Bun.serve({port:0})` 崩"这个触发条件也就不存在了。

**验证**：

```text
$ env PATH="$(dirname $(which bun)):/usr/bin:/bin" bun run benchmark/probe-agent-search-coverage.ts …
[gray] ✗ ACP 会话失败: Executable not found in $PATH: "kiro-cli"
EXIT=1
ls: /tmp/fail.json: No such file or directory      ← 没有伪造报告
$ bun run benchmark/probe-agent-search-coverage.ts …   （正常路径）
EXIT=0
```

### P2 `/health` 的回滚读数滞后

**问题**：`/health` 用 Worker 启动时缓存的 config。灰度开关按 MCP 进程读取，所以把磁盘配置
改成 `false` 之后，新会话已经走回滚策略，而常驻 Worker 仍报 `default /
semantic_discovery=true`——与 README "用 /health 确认回滚是否生效"直接矛盾。

**整改**：新增 `readSemanticDiscoverySwitch(fallback)`，`/health` 每次调用从磁盘读当前值；
文件缺失或不可读时回落到注入的 config（新装 / 测试），并且只有显式 `false` 才算回滚——
与 `loadConfig()` 同一条规则。一次小 JSON 读，`/health` 不在任何热路径上。

**验证**：新增用例 `GET /health 反映磁盘上的灰度开关，无需重启 Worker（Gate C P2）`：
不重启 app，只改磁盘 → `lexical-anchor-rollback / floor 0.2 / cap 'none'`；改回去 → 立刻
`default`；只写 `{"language":"zh"}` → 仍是 `default`（缺键不等于要求回滚）。

### 工作区

- `undefined/kiro-mem.db*`：来自我自己的一次 `bun -e` 调试命令——`process.env.D` 在那次调用里
  没有被导出，模板串算出了字面量路径 `undefined/kiro-mem.db`，里面只有那次手工插入的 2 条
  search 指标（`turns=0 observations=0`）。已确认内容后删除，`git status` 无残留。
- `git diff --check` 报的 `src/db/schema.ts:426` 文件末尾空行已删；现在 `git diff --check` 干净。

第一轮整改后的读数：`bun test` **441 pass / 0 fail**，`bun run typecheck` 干净。（第二轮整改后的读数见下一节。）



## Gate C 第二轮整改（Codex 反馈 2 项）

Gate C 第一轮整改后仍未通过，两项补齐如下。安装/迁移兼容不再是阻断项——用户已确认唯一
受支持的升级方式是 `stop → uninstall --purge → 重装`，README（中英）已改写成"唯一受支持
路径"，并把 `--purge` 会永久删除全部历史记忆与配置写成醒目警告块（含"先 stop 不是可选项"
与"V2 副本 V3 读不回来"）。

### 1. 补齐 scope 内向量数量观测

**问题**：方案 §8.2 要求观测"scope 内向量数量"，而现有两个数字都不是它——
`/health` 的 `embeddings.byProtocol` 是**整个 dataDir** 的全局数量；`comparableVectors`
是**候选池**（FTS 命中 ∪ scope 最近 200 条）里的可比向量数，workspace 一大就饱和。

**整改**：新增 `MemoryDB.countScopeVectors({scopeKey, model, dimensions})`——按 scope +
完整空间键 + 维度 COUNT，**不**按 type/days 过滤（那两个约束描述一次请求，而这个字段描述
语义腿在这个 scope 里能触达的语料）。检索内核在语义步骤里调用它，经 `onCandidates` 报出
`scopeVectors`；MCP server 写入新列 `metric_events.scope_vectors`（同一份幂等 `ALTER`
迁移）。聚合新增 `scopeVectorsAvg / scopeVectorsMin / scopeVectorsMeasured /
emptyScopeRequests`，`/health` 与 `kiro-mem diagnose` 一起报。

三个刻意的设计：

- **计数在 embedding 之前、且在它的 try 之外**：Worker 挂了而降级的请求，照样要能回答
  "这个 scope 有没有向量"——那个答案不该取决于这次 query 能不能编码。
- **`null` ≠ 0**：语义步骤没跑到（回滚 profile、或非英文空间的零锚点提前返回）记 `null`。
  记 0 等于告诉运维"这个 workspace 没建过向量"，把一次策略选择说成一次重建缺失。
- **只落数字**：scope key、workspace 路径、正文一个都不进指标表。

**验证**：

- `countScopeVectors 只数指定 scope + 指定空间键`：跨 scope、跨空间键、维度不符、省略
  scopeKey（= 全 dataDir，即显式 all-scopes 真正搜的范围）逐项断言。
- `scopeVectors：未测量（null）与真的为 0 分开`：`scopeVectorsMeasured=2`（null 不计）、
  `scopeVectorsAvg=20`、`scopeVectorsMin=0`、`emptyScopeRequests=1`。
- 隐私：指标行列名集合断言更新为含 `scope_vectors` 的 13 列，仍然没有任何可放文本的列。
- 迁移：4 列旧表升级后 `scopeVectorsMeasured=1 / Avg=12`——漏补一列就是这一列永远为空。
- 真实 MCP 路径：zero-FTS 召回那行 `scope_vectors=2`；新增用例断言**回滚 profile 下
  `scope_vectors` 为 NULL 而不是 0**（该 scope 明明有 1 条向量）。
- 离线回归：加了这个 COUNT 之后重跑默认策略，与 Gate B 选中 arm 仍 **0/145 逐 query 差异**，
  只有 latency p50/p95 变（p95 11.3ms）。

### 2. 补强真实 Agent 灰度证据

**问题**：Codex 独立跑两轮，一轮 5 条 prompt 全部正常结束却**一次都没调用**
`@kiro-mem/search`（`metric_events` 为 0，探针正确非零退出），另一轮正常。也就是说：
search 一旦发生，覆盖与召回链路都正常；但 Agent 是否稳定选择检索有波动。而旧报告只报
"发生了的 search 里有多少走英文空间"——那一轮是 0/0，聚合起来仍显示 100%，把"没有证据"
读成了"没有问题"。

**整改（探针）**：

- `--rounds=N`（默认 3）：每轮一个**全新** `kiro-cli acp` 进程 + 新会话；
- 每条 prompt 前后取 `MAX(id)` 水位线，把指标行**归属到具体 prompt**；
- 新增会话级口径 `prompt 调用了 search`（需要检索的 prompt 里有多少真的搜了）；
- 三种情况分开报：**未调用 search** / **调了工具但没落盘**（如 scope 解析失败，走不到内核）
  / **调用了但英文形式缺失或被拒**；
- 全部轮次留档（`rounds[]` 逐轮逐 prompt 进 JSON 与 Markdown），成功失败一视同仁；
- 退出码语义：基础设施失败（Worker/ACP 起不来）或**所有轮次都没采到指标** → `exit 1`；
  单轮没搜到不再直接判死，而是如实计入分布。

**整改（agent prompt）**：Codex 那一轮"正常结束但没搜"最可能的机制是——注入索引里已经有
6 条语料的**标题**，模型据此就答了。这是产品层的真实缺口，不只是探针问题。`prompt.md`
因此新增一段（中英双语）：

> 注入的索引是标题清单，不是内容。标题只说明"有这么一条记录"，不说明当时决定了什么、
> 坏在哪、验证了什么。所以用户问历史工作时，即使索引里某个标题看着已经能回答，也要调用
> `search`（然后 `get_observations`）——只凭标题作答就是带引用的猜测。"我们做过 X 吗？"
> 同样如此：先搜再说没有，并说明你搜过了。

**实测（6 轮独立会话，30 条 prompt）**：

| 口径 | run A（3 轮） | run B（3 轮） |
| --- | ---: | ---: |
| prompt 调用了 search | **15/15 = 100%** | **15/15 = 100%** |
| 完全没搜的轮次 | 0/3 | 0/3 |
| 调了工具但没落盘 | 0 | 0 |
| 会话级错误 | 0/3 | 0/3 |
| search 请求数 | 18 | 17 |
| 走 `semantic-en-v1` | **18/18** | **17/17** |
| 缺失或被拒英文形式 | 0 | 0 |
| 降级（FTS-only） | 0 | 0 |
| zero-FTS / 其中靠语义召回 | 11 / **8** | 10 / **8** |
| semantic-only 每请求 / 最坏 | 0.889 / **2** | 0.882 / **2** |
| scope 内向量 均值 / 最小 / 测量到 | 6 / 6 / 18 | 6 / 6 / 17 |
| scope 无向量的请求 | 0 | 0 |
| p50 / p95 | 13ms / 37ms | 11ms / 29ms |

诚实的边界：Codex 观察到的"整轮不搜"是**低频**事件，我在改 prompt 前后各自的多轮运行里
都没能主动复现它，所以这条 prompt 修改是**针对已观察机制的定向缓解**，不是"复现 → 修复 →
不再复现"的闭环证据。6 轮 30 条 prompt 全部调用 search、35 次 search 全部走英文空间，是
当前能给出的最强读数；判不判通过仍由 Codex 决定。探针现在把这种波动做成了可测量的口径
（`promptSearchRate` / `roundsWithNoSearchAtAll`），复跑即可积累样本。

整改后：`bun test` **444 pass / 0 fail**，`bun run typecheck` 干净，`git diff --check` 干净。

## 改动范围

### 文件

| 文件 | 行为变化 |
| --- | --- |
| `src/server/observation-search.ts` | `DEFAULT_RETRIEVAL_POLICY` 改为 `{discovery:true, floor:0.197, cap:2}`；新增 `LEXICAL_ANCHOR_ROLLBACK_POLICY`（完整 1b profile）与 `resolveRetrievalPolicy()`；`onCandidates` 新增 `comparableVectors` 与 `scopeVectors`（`null` = 未测量）；改写 floor/cap/门 的注释——旧注释把 0.2 说成 `raw-v1` 校准值、把 expected-empty=0 说成结构恒真，2C 之后两句都是错的 |
| `src/config.ts` | 新增 `retrieval.semanticDiscovery`（默认 `true`，**只有显式 `=== false`** 才回滚） |
| `src/server/mcp-server.ts` | 删除 2B 验证缝；进程启动时 `resolveRetrievalPolicy(config.retrieval.semanticDiscovery)` 解析一次并显式传给内核；接 `onCandidates` / `onFusion` 落盘检索指标 |
| `src/db/schema.ts` | `metric_events` 新增 **8 列**（含 Gate C 第二轮的 `scope_vectors`）+ 幂等 `ALTER` 迁移 `migrateMetricEventsSearchColumns()`；`migrateSchema()` 变成两步分发 |
| `src/db/index.ts` | 新增 `countScopeVectors()`；`recordSearchMetric()` 扩参（全部可选）；`search24h` 新增 p50、协议分布、`semanticEnRate`、`semanticQueryIssues`、`discoveryEffective`、`zeroFts`/`zeroFtsRecalled`、`semanticOnly{Total,PerRequest,Max}`、`comparableVectorsAvg`、`scopeVectors{Avg,Min,Measured}`、`emptyScopeRequests` |
| `src/db/types.ts` | `ObservabilityStats.search24h` 类型同步 |
| `src/server/worker.ts` | `/health` 新增 `retrieval` 块（生效 profile + floor + cap），**每次调用从磁盘读灰度开关**（Gate C P2） |
| `scripts/setup.ts` | `defaultConfig()` 写出开关；`config --show` 显示生效 profile；`diagnose` 新增 discovery/覆盖率、zero-FTS/semantic-only、缺失或被拒原因三行 |
| `src/i18n.ts` | 上述 diagnose 与 config 标签的 zh/en |
| `src/agent/prompt.md` | 新增 `match_source` 语义表 + semantic-only 的核实要求（破坏性操作前用 `get_observations` / 当前代码核实；**不是**"不可信所以忽略"）；Gate C 第二轮新增"注入索引是标题清单、不是内容"——问历史工作必须搜，不能只凭标题作答 |
| `README.md` / `docs/i18n/README.zh.md` | 升级说明改写成"唯一受支持路径"+ `--purge` 永久删除警告块；检索指标表新增 `scopeVectors` / `emptyScopeRequests`；新增配置项、「独立语义召回与回滚」、「检索指标」两节；改写 Hybrid Search 特性行与检索层架构描述；Limitations 删掉「搜索需要关键词锚点」，换成「纯语义结果未经核实」与「独立召回依赖英文形式」，并改写语义窗口行 |
| `benchmark/run.ts` | expected-empty 的生成文案与门槛注释改为 policy-aware（旧文案在每份新报告里断言"检索层要求词汇锚点"，2C 之后是假话） |
| `benchmark/README.md` | 同上两处收口说明 |
| `benchmark/probe-agent-search-coverage.ts` | 新增：真实 Agent 路径的覆盖率实测脚本（§8.3）。Worker 以子进程启动、不导入 `worker.ts`、失败即 `exit(1)`（Gate C 第一轮）；`--rounds=N` 多轮独立会话 + 逐 prompt 指标归属 + 三种失败分开报 + 全轮留档（Gate C 第二轮） |
| `tests/…` | 见「测试」 |

`git diff --stat`：14 个已跟踪文件 +1303 / −109，另有 1 个新脚本与 6 份新报告（未跟踪）。

### 明确未改的变量

模型、`semantic-en-v1` 协议、FTS tokenizer 与 `FTS_MIN_UNIT_LEN`、`rrfK=60`、权重 `1:1`、
`tieBreak=recency`、200 条候选池、默认 90 天窗口、`limit` 默认值、MCP 工具 schema、
Observation 写入路径、向量空间键。RRF 平局与权重属于 2D，本轮一个字没动。

## Provenance

- commit `b2e972f`，**工作区有未提交改动**（Phase 1b/2A/2B/2C 全部未提交，与 2B 提交时同一状态）
- Bun 1.2.20 / darwin arm64；`kiro-cli 2.15.1`
- 检索策略（生产默认，无任何 flag）：`discovery=on floor=0.197 semanticOnlyLimit=2 rrfK=60 w(fts:sem)=1:1 tieBreak=recency`
- 数据集 checksum（与 2B 同一份）：`turns.json aa8f9beda2a4`、`queries.json 95ee03d880a9`
- 基准命令（**刻意不传任何 policy flag**，验的就是"默认值等于 Gate B 选中的工作点"）：

  ```bash
  bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout \
    --report=benchmark/reports/phase2c-default-policy.md \
    --json=benchmark/reports/phase2c-default-policy.json
  ```

- 灰度实测命令：

  ```bash
  bun run benchmark/probe-agent-search-coverage.ts
  bun run benchmark/probe-agent-search-coverage.ts \
    --report=benchmark/reports/phase2c-agent-coverage-run2.md \
    --json=benchmark/reports/phase2c-agent-coverage-run2.json
  ```

## 指标

### 1. 默认策略 == Gate B 选中工作点（离线，145 条 query）

`phase2c-default-policy.json` 与 `phase2b/arm-f0.197-c2.json` 对比：

| 对比项 | 结果 |
| --- | --- |
| 报告打印的 policy | 两份完全一致（`discovery=on floor=0.197 cap=2 rrfK=60 1:1 recency`） |
| 逐 query 行（忽略 `latencyMs`） | **145 / 145 完全一致**，差异 0 |
| `retrievalMetrics` 67 个字段 | 仅 `latencyP50` / `latencyP95` 不同（运行波动），其余 65 项逐字段相等 |

关键读数（两份相同）：

| 指标 | 值 |
| --- | ---: |
| Phase 2 校准集 relevance / hit@5 / MRR | 72 条 / **50.0%** / **0.458** |
| Phase 2 empty 平均 / 最坏 | 0.59 / 2 |
| 既有 expected-empty 平均 / 最坏 | 1.00 / 2 |
| 既有 tuned hit@5 / MRR / R-precision | 100.0% / 0.889 / 83.3% |
| semantic-only 均值 / 最坏 | 1.08 / **2**（== cap） |
| 跨 scope 泄漏 | 0 |
| 协议混排 / 护栏拒绝 | 0 / 0 |
| search p95 | 12.0ms |

结论：**没有任何"顺手改"的收益混进来**——默认值切换是纯粹的配置冻结，不是新一轮调参。

### 2. 灰度实测：真实 Agent 路径（§8.3）

**读数见上面「Gate C 第二轮整改 §2」的 6 轮表。** 这里不重复一份数字——第一轮提交时的
单轮读数（5 次 search / zero-FTS 3 里召回 2）已被 6 轮 30 条 prompt 的运行取代，两份表并存
只会让"当前实测是多少"变成需要推断的事。逐轮逐 prompt 原始数据在
`benchmark/reports/phase2c-agent-coverage{,-run2}.json` 的 `rounds[]` 里。

行为侧证据（两次运行一致，不是计数）：

- 除 hard negative 那轮外，Agent 每轮都在 `search` 之后调用 `get_observations` 才作答——
  `prompt.md` 的核实要求在真实路径上被执行了；hard negative 轮没有可核实对象，也就没有调用。
- hard negative（问 Istio 灰度发布，本项目从未做过）稳定表现为 `fts=0 semantic=0` 返回空——
  floor 在真实 query 上生效，不是只在离线集上生效。

### 3. 观测面本身可用

- `metric_events` 每行只有计数、枚举原因、延迟。测试断言列名集合，并断言 query 正文、
  英文形式、Observation 正文、workspace 路径都不出现在行里。
- 4 列旧表升级：增量 `ALTER`，旧行保留（`requests`/`ftsOnly` 仍算得出），新列可写，重复
  打开幂等。**不重建表**——1b 踩过的复合主键不兼容来自重建，这次刻意避开那一类。
- 旧行的新列为 `NULL`，聚合按"未知"计：不会凭空造出 zero-FTS，也不会把旧流量算成 raw。
- `/health` 报出生效 profile（`{semantic_discovery, profile, semantic_floor, semantic_only_limit}`），
  每次调用从磁盘读，所以"回滚生效了吗"不需要读代码，也不会读到 Worker 启动时的旧值。
- scope 内向量数按请求落盘（`scope_vectors`），聚合成 `scopeVectorsAvg/Min/Measured` 与
  `emptyScopeRequests`；`null` 表示语义步骤没跑到，与 0（scope 真的没向量）分开。

## 逐 query 变化

与 Gate B 选中 arm 对比：**改善 0 / 退化 0 / 不变 145**，这是本阶段的**目标**而不是遗憾——
2C 只允许改发布机制，不允许改检索结果。最大退化：无（差异集为空）。

与 Phase 1b（关键词门）对比的逐 query 变化已在 2B 报告留档，本轮不重复计入。

## 测试

```text
bun test          → 444 pass / 0 fail / 1285 expect（45 文件）
bun run typecheck → 干净
git diff --check  → 干净
```

本轮新增或改写：

| 文件 | 内容 |
| --- | --- |
| `tests/integration/retrieval-policy.test.ts` | 默认策略回归锁改成 `{true, 0.197, 2}`；新增回滚 profile 逐字段锁、`resolveRetrievalPolicy` 只在两个冻结 profile 间切换、默认策略下 zero-FTS 会算 embedding 并独立召回、回滚下同一 query 不算 embedding 且返回空、默认 cap=2 生效、默认 floor 严格大于（0.197 丢 / 0.198 留）；把原先依赖"默认关门"的用例改成显式传 profile |
| `tests/integration/mcp-discovery.test.ts` | 开关改由**临时 dataDir 的 `config.json`** 驱动（就是文档写的回滚路径，环境变量缝已删）；新增「回滚开关：同一 query 回到关键词门」；新增 5 个「检索观测落盘」用例：zero-FTS 语义召回的指标行内容（含 `scope_vectors`）、**回滚下 `scope_vectors` 记 NULL 而非 0**、missing 与护栏拒绝分开记、聚合读数与冻结 cap 一致、指标不含 query 正文 |
| `tests/db/observability.test.ts` | 空窗口零态逐字段；协议分布与覆盖率；zero-FTS 与"靠语义找回"分开计数；`comparableVectors` 均值；**`countScopeVectors` 的 scope/空间键/维度隔离**；**`scopeVectors` 的 null 与 0 分开**；2C 之前的行按未知计；指标行列名集合（隐私边界，含 `scope_vectors`）；4 列旧表迁移 + 幂等（含新列可写） |
| `tests/integration/ingest.test.ts` | `/health` 断言新增字段与 `retrieval` 块；新增「`/health` 反映磁盘上的灰度开关，无需重启 Worker」（Gate C P2 回归锁：改磁盘 → 回滚可见 → 改回 → 立刻可见 → 缺键不等于回滚）；显式钉住测试用 config，避免读开发者本机 profile |

## 已知限制

1. **灰度样本仍然小。** 6 轮独立会话 / 30 条 prompt / 35 次真实 search、6 条虚构语料、单一
   workspace、单一模型。它能证伪"模型长期不传英文形式"，也能量化"会不会不搜"，但给不出
   生产覆盖率分布。**Codex 观察到的"整轮不搜"我没能主动复现**，所以 prompt 那处修改是定向
   缓解，不是闭环证据。
2. **既有 expected-empty 仍是 1.00 / 门槛 ≤1，零余量。** 这是 Gate B 已登记的风险，2C
   没有改善它（也不该改——改了就是新一轮调参）。生成器注释与 benchmark README 已改成
   "紧的门槛"，不再写成形式化的不回退锁。
3. **Codex 审计集的 3 条低分假阳性没有被消除。** cosine 0.21–0.29，贴着 floor 0.197。
   运行侧对应的观测是 `semanticOnlyPerRequest` 与 `semanticOnlyMax`；本轮实测均值 0.8。
4. **回滚生效粒度是"下一个会话"。** MCP server 在进程启动时解析一次 policy，正在运行的
   会话不会热切。可接受（session 生命周期短），但运维要知道。
5. **两个向量计数含义不同，不要混读**：`comparableVectors` 是候选池内（FTS 命中 ∪ scope 最近
   200）的可比向量数，`scopeVectors` 才是整个 scope 的数量。前者在大 workspace 上会饱和；
   后者不按 type/days 过滤，所以它描述的是"语义腿在这个 scope 里能触达的语料"，不是这一次
   请求的候选面。README 已按此措辞写。
6. **覆盖率脚本去掉了 agent JSON 的 `resources`**（本机 skill/steering 通配），其余字段与
   `kiro-mem install` 写下的一致。留着会把开发者本机文件混进读数、使其不可复现。
7. **未验证项**：多 workspace 并发下的指标归属（当前指标不带 scope，刻意如此）；Worker
   长时间不可用时的降级率抬升在真实流量下的形状（单测覆盖了行为，没有生产曲线）。
8. **`worker.ts` 顶层生产单例本身仍在**（Gate C P1-1 暴露出来的既有设计）。`import` 该模块
   即打开 `getDataDir()` 下的库；`bun test` 靠 `tests/support/preload.ts` 兜住，探针现在靠
   "不导入 + 子进程"兜住。真正的收口是把单例改成惰性初始化，但那会动生产启动路径，超出 2C
   范围，**登记在此不在本轮修**。新写脚本时的规则：要么不导入 `worker.ts`，要么在导入前就把
   `KIRO_MEMORY_DATA_DIR` 指向临时目录。

## 请求 Codex 验证

对应 **Gate C**（方案 §8.4）。建议独立复跑：

```bash
# 1. 默认路径确实已移除关键词前置条件 + 逐 query 等于 Gate B 选中 arm
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout \
  --report=/tmp/gatec-default.md --json=/tmp/gatec-default.json
bun -e 'const a=await Bun.file("benchmark/reports/phase2b/arm-f0.197-c2.json").json(),
  b=await Bun.file("/tmp/gatec-default.json").json();
  const s=r=>{const{latencyMs,...x}=r;return JSON.stringify(x)};
  console.log("policy",JSON.stringify(b.provenance.retrievalPolicy));
  console.log("diff",a.queryRows.filter((r,i)=>s(r)!==s(b.queryRows[i])).length,"/",a.queryRows.length)'

# 2. 回滚 flag 不改 schema / 向量协议（改 config → 同一 query 返回空 → 改回 → 又能召回）
bun test tests/integration/mcp-discovery.test.ts

# 3. 观测不记录敏感正文 + 迁移顺序与幂等
bun test tests/db/observability.test.ts

# 4. Worker 失败 / 超时仍安全降级（zero-FTS 也走 deadline）
bun test tests/integration/retrieval-policy.test.ts

# 5. 全量
bun test && bun run typecheck

# 6. 真实 Agent 路径覆盖率（会起真实 kiro-cli acp，约 2–4 分钟）
bun run benchmark/probe-agent-search-coverage.ts --report=/tmp/gatec-coverage.md --json=/tmp/gatec-coverage.json

# 7. 隔离（P1-1）：运行前后真实库指纹必须一致
stat -f '%N mtime=%m size=%z' ~/.kiro-mem/kiro-mem.db* > /tmp/before.txt
bun run benchmark/probe-agent-search-coverage.ts --report=/tmp/c.md --json=/tmp/c.json
stat -f '%N mtime=%m size=%z' ~/.kiro-mem/kiro-mem.db* > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "未触碰真实库"
grep -cE "^import .*server/worker" benchmark/probe-agent-search-coverage.ts   # 期望 0（注释与子进程路径串会命中普通 grep，这里只数 import 语句）

# 8a. 多轮会话级覆盖率（Gate C 第二轮，约 6–10 分钟）：读 promptSearchRate / roundsWithNoSearchAtAll
bun run benchmark/probe-agent-search-coverage.ts --rounds=3 --report=/tmp/g3.md --json=/tmp/g3.json

# 8b. 失败即非 0（P1-2）：让 kiro-cli 不在 PATH 上
env PATH="$(dirname $(which bun)):/usr/bin:/bin" \
  bun run benchmark/probe-agent-search-coverage.ts --report=/tmp/f.md --json=/tmp/f.json
echo "EXIT=$?"     # 期望 1，且 /tmp/f.* 不存在
```

请求重点复核：

1. `hybridSearchObservations` 里已不存在任何"关键词 0 条则提前返回"的**默认**路径：
   剩下的那一处 `if (!discoveryEffective && ftsResults.length === 0)` 只在（a）运维显式回滚、
   （b）不在 `semantic-en-v1` 空间 两种情况下可达；
2. `retrieval.semanticDiscovery` 只在 `=== false` 时回滚，缺失/null/字符串都保持默认——
   升级到 2C 的旧 config 不会被读成"运维要求回滚"；
3. 回滚 profile 是**整份 1b**（门 + floor 0.2 + 无 cap），不是"只关门"，因为只有整份有 2A
   的逐 query 等价证据；
4. `metric_events` 迁移是增量 `ALTER` 而非重建，旧 Worker 与新表共存不会写坏；
5. `semanticOnlyMax` 在离线（2）与真实 Agent（1）两侧都 ≤ cap；
6. 指标行不含 query / Observation / workspace 路径（列结构即隐私边界）——`scope_vectors` 只是
   一个整数，scope key 不落盘；
7. `scopeVectors` 的 `null` 与 `0` 在聚合里确实分开（`scopeVectorsMeasured` 不把 null 计入）；
8. 探针的会话级口径可复算：`promptSearchRate`、`roundsWithNoSearchAtAll`、
   `promptsToolCalledButNoRow`、`searchesRejectedOrMissing` 都能从 `rounds[]` 逐 prompt 重算。

## 证据文件

- `benchmark/reports/phase2c-default-policy.{md,json}` — 无 flag 默认策略运行
- `benchmark/reports/phase2c-agent-coverage.{md,json}` — 真实 Agent 覆盖率 run1
- `benchmark/reports/phase2c-agent-coverage-run2.{md,json}` — run2
- `benchmark/probe-agent-search-coverage.ts` — 覆盖率实测脚本
- `benchmark/reports/phase2b-codex-gate-b-decision.md` — 上游 Gate B 决议
