# kiro-mem V3 质量基准集

对应技术设计 §12.3 与发布清单 §5.1。单元测试只能证明代码契约，证明不了**摘要质量**与**检索精度**；这个基准集把两者变成可重复测量的数字。

该目录不在 `package.json` 的 `files` 列表里，不会发布到 npm。

## 运行

```bash
# gold 压缩器：不依赖 kiro-cli，建立检索/隔离/延迟基线，同时自检打分器
bun run bench

# 真实 ACP 压缩器：测量真实摘要质量（需要 kiro-mem install 过的 kiro-runtime）
bun run bench:acp

# 其它参数
bun run benchmark/run.ts --compressor=acp --concurrency=2 --report=/tmp/r.md --no-embeddings
```

退出码 0 表示全部门槛通过，1 表示存在未达标项。报告写到 `benchmark/reports/<compressor>-latest.md`。

`--no-embeddings` 是诊断模式，**预期会红**：它让 heldout hit@5 从 44.4% 掉到 38.9%（低于 40% 的门槛）。这正是它要回答的问题——语义重排在"换一种问法"的 query 上值 5.6 个百分点（一条 query）。CI 只跑 `bun run bench`（hybrid），不跑这个模式。

评估全程使用临时数据目录与临时 SQLite，**不读写开发者真实 `~/.kiro-mem`**。ACP 模式例外地只读引用真实 `<dataDir>/kiro-runtime`，以复用已安装的压缩子 Agent。

## 两种压缩器

| 模式 | 用途 |
| --- | --- |
| `gold` | 直接返回人工标注。用于（a）在没有 kiro-cli 的环境里建立可重复的检索基线；（b）自检打分器——gold 跑出来的摘要类指标必须接近满分，否则是打分器有 bug 而不是系统有 bug。 |
| `acp` | 走真实 `kiro-cli acp` 子进程与生产 prompt，测量真实摘要质量。 |

两种模式都复用**生产合成链路**：`createApp()` 注册的 `summarize_turn` / `embed_observation` job、`hybridSearchObservations()`、`buildBootstrapContext()`。

不过有一处**是复制的**，必须写清楚：**摄入层**。`run.ts` 手写了 `worker.ts` 三个 HTTP 路由内部的编排来播种 turn，而不是打 HTTP。因此下列生产行为不在基准结论覆盖范围内：

- `<private>` 脱敏（`stripPrivateTags`）
- 工具过滤（`shouldSkip` / `filter.skipTools`）
- 陈旧 open turn 的补队逻辑
- 本地 token 认证（播种时 `enableAuth: false`）

这些都由单元/集成测试覆盖（见 `tests/integration/`），但基准跑绿**不等于**它们跑绿。

## 数据集

`dataset/turns.json` — 30 个标注 turn（primary 26 / other 4），取材于本仓库 V3 的真实开发历史（提交记录、发布评审清单、实际测试输出），人工标注并脱敏。4 条 `scope: "other"` 属于另一个 workspace，**故意与主 scope 共用词汇**（token/401/search/超时），用来检验 scope 硬隔离而不是词汇差异。

每条包含：

| 字段 | 含义 |
| --- | --- |
| `prompt` / `assistant_response` | 真实的用户请求与助手最终回复 |
| `events[]` | 要回放的工具事件，形状与 `postToolUse` hook 的 payload 一致 |
| `annotation.completed` | 这一轮是否真的做完 |
| `annotation.key_files` | 关键文件，应出现在 `Observation.files_touched` |
| `annotation.key_facts` | **可核对事实标记**，应保留在 Observation 正文中（如 `138 pass`、`0600`、`384`）。按 **token 边界**匹配：语序与中间插入的词不影响判定（`coverage 是 1.0` 命中 `coverage 1.0`），但短事实不会再意外命中（`en` 不再匹配 `content`）。需要接受中英/同义表达时写成 `{ "any": ["3 errors", "3 个错误"] }`——让"什么算同一个事实"留在可审阅的数据里，而不是藏在打分器的启发式里。匹配实现与单测见 `benchmark/scoring.ts` 与 `tests/benchmark/scoring.test.ts`。 |
| `annotation.unfinished` | 未完成项；非空时 `next_steps` 必须非空，空时必须为空 |
| `annotation.forbidden_claims` | 不允许出现的断言，用于检测虚构完成状态 |
| `annotation.title/summary/outcome/learned/concepts` | 人工参考 Observation，`gold` 模式直接返回它 |

`dataset/queries.json` — 42 个标注 query，分三类：

- `relevance`（36 条）：有应命中的 Observation，度量召回与排序。再按 `origin` 分两半：
  - `tuned`（18 条）：最初那批，检索实现就是在它们上调的（D1 修复让 gold hit@5 从 66.7% 升到 94.4%）。它的门槛是**连续性锁**，不能当泛化证据。
  - `heldout`（18 条）：后补且未据此改任何检索参数。7 条覆盖此前完全没有 query 的 turn，11 条是已覆盖 turn 的另一种问法。**这才是泛化读数。**
- `empty`（5 条：q19、q21–q24）：本 scope 内既无相关记忆也无合法词汇重叠，理想返回空。
- `leakage`（1 条：q20）：只检验跨 scope 硬隔离，**可以**有本 scope 的合法命中，因此不计入 expected-empty。

三类的 `expect` 语义不同，不能互相推断——`empty` 与 `leakage` 的 `expect` 都是空数组，但前者意为"什么都不该返回"，后者只意为"不该返回别的 scope 的记录"。泄漏检查对**所有** query 生效，不只是 `leakage` 那条。`origin` 对 relevance 是必填项：缺省就等于把 heldout 混进 tuned，脚本会直接退出。

**当前分层结果（gold）：tuned hit@5 94.4%，heldout hit@5 44.4%。** 50 个百分点的差距说明检索对调优过的问法有效、对同一批工作的另一种问法只有一半有效。诊断：heldout 里 9/18 条一个字面词都没命中；关掉词汇锚点规则只能升到 50.0%，所以主因是 FTS trigram 对自然语言换说法无效，而不是锚点规则。

## 指标与门槛

门槛按**举证能力**分四类。混在一张「全部通过」表里对外阅读即构成夸大，所以报告与下表都分开列。

**有判别力**——会因为实现变差而变红：

| 门槛 | 阈值 | 依据 |
| --- | --- | --- |
| Top-5 至少一条标注命中（**tuned** 18 条） | ≥ 90% | §12.3「search 对标注 query 的 Top-K 中至少一条有直接帮助」。检索曾在这批上调优，故为**连续性锁** |
| Top-5 至少一条标注命中（**heldout** 18 条） | ≥ 40% | 泛化读数。实测 44.4%——**这个水平不可接受**，门槛只是防止再退 |
| R-precision（tuned，截断点 R = \|expect\|） | ≥ 55% | 误召回侧；**不回退锁**，非质量目标 |
| R-precision（heldout） | ≥ 35% | 同上，实测 38.9% |
| expected-empty query 平均返回条数 | ≤ 1 | 误召回侧；**门槛就是目标值 0**（留 1 条余量见下） |
| search p95 | < 300ms | §12.3 Hook 延迟 |
| bootstrap 构建 | < 100ms 且在字节预算内 | §7.3 |

后两条余量在数量级上（实测 ~25ms / ~12ms），短期内不会变红，报告里单列为「性能门槛」。

**自检**——gold 压缩器把标注逐字搬进结果，而打分器读的是同一份标注，所以这些项在 gold 下测的是「评分管道与播种→job→入库→检索链路是通的」，**不是**摘要质量。只有 `--compressor=acp` 下它们才有判别力：

| 门槛 | 阈值 | 依据 |
| --- | --- | --- |
| outcome 非空率 | ≥ 90% | §12.3 Summary 完整性 |
| next_steps 未完成项召回 | ≥ 85% | §12.3「next step 缺失率」 |
| 关键事实召回（token 边界） | ≥ 80% | §12.3 事实准确性 |
| 关键文件召回 | ≥ 80% | §12.3 事实准确性 |
| 虚构完成断言 turn 数 | = 0 | §6.5 outcome 必须与证据一致 |
| 幻觉文件 turn 数 | = 0 | 只有本轮任何证据里都没出现过的路径才算幻觉 |

**结构性恒真**——三条检索 SQL 都无条件拼 `AND scope_key = ?`，所以这两项测的是「那行 WHERE 没被删掉」，恒为 0。保留作结构回归，但它不是隔离质量的证据；真正会出错的授权层是 `src/server/mcp-scope.ts`，本基准不调用它：

| 门槛 | 阈值 |
| --- | --- |
| 跨 workspace 检索泄漏 | = 0 |
| 跨 workspace bootstrap 注入 | = 0 |

### 误召回侧的两条新指标

原来整套评估只有 hit@k，只能证明「没漏」，证明不了「没乱给」。

- **R-precision**，而不是 precision@5：标注集里 `expect` 通常只有 1 条，precision@5 的上限就是 20%，测出来只是 hit@5 的另一种写法。R-precision 的截断点跟着标注规模走，1.0 表示前 R 条正好命中标注的 R 条。gold 实测 61.1%，而 hit@5 是 94.4%——差距说明正确答案通常进了 Top-5 但常常不在第 1 位。
- **expected-empty query 平均返回条数**：标注为 `kind: "empty"` 的 query（q19、q21–q24）——本 scope 内既无相关记忆也无合法词汇重叠——理想应返回空。gold 实测 **0.00（最坏 0）**。
  - 取样按**显式 kind**，不能用 `expect.length === 0` 推断。leakage 类的 `expect` 也是空的，但它空的含义是"不该返回**别的 scope**的记录"：q20 故意与本 scope 的 401/token 词汇重叠（`401` 在 t11/t19，`token` 在 5 条 primary turn），返回本 scope 命中是正确行为。第一版用推断口径把 q20 算了进去，指标因此偏高（8.5），并且会把"压制正确结果"变成优化方向。
  - 收口方式是检索层的词汇锚点规则：本 scope 的 FTS 无命中即返回空（`src/server/observation-search.ts`）。校准数据说明门槛路线走不通——真正例 cosine 0.080–0.607（中位 0.322），而无关 query 的噪声上限 0.431，两个分布重叠。
  - 门槛留 1 条余量只为一种情况：acp 模式下 Observation 正文由模型生成，某条 empty query 可能因此获得**真实**的词汇锚点。零锚点必返回空这条硬不变量由单测钉住（`tests/integration/search.test.ts`），不依赖这条门槛。

两个只报告、不设门槛的参考项：

- **`memory_type` 与标注一致率**：粗分类，`feature`/`bugfix`/`refactor` 之间存在合理分歧。
- **`next_steps` 过度生成率**：标注无未完成项但模型仍写了 `next_steps`。§12.3 关心的是「缺失率」，即有未完成项却没写出来；反向的过度生成危害小得多，单独统计。

### 两条口径说明

**事实标记按 token 边界匹配，不是整串子串。** 详见上面 `annotation.key_facts` 一行与 `benchmark/scoring.ts`。旧的「去掉空白后做 substring」在两个方向上都会错：把 `coverage 是 1.0` 判成丢了 `coverage 1.0`（惩罚正确输出），又让 `en` 在 `content` 里意外命中（虚高）。

**标注的未完成项必须在 turn 输入里有依据。** 首轮数据集里 t16、t17 犯了这个错：`annotation.unfinished` 写了待办，但 `assistant_response` 和工具证据里没有任何「还没做」的表述——那个待办来自发布评审文档而不是这一轮对话。要求压缩器在这种输入下产出 `next_steps`，等于要求它虚构，而虚构本身是另一条门槛在惩罚的行为。两条已修正为忠实输入。**新增标注时必须自检这一点。**

### 报告的 provenance 与方差

每份报告头部带 provenance 块：commit（含工作区是否脏）、数据集与脚本的 sha256 前缀、embedding 模型、命令行、Bun 版本与平台。只记生成时间无法自证是哪个版本产出的，而文件 mtime 不是 provenance。

ACP 压缩器每轮输出会波动，单次运行不足以支撑任何结论。用 `--runs=N` 跑多次并输出均值/极值/样本标准差：

```bash
bun run benchmark/run.ts --compressor=acp --runs=3
```

`min` 才是可以对外承诺的下界。gold 模式下所有标准差应为 0——这本身是一条确定性自检。

#### 首次三次运行的实测结果（acp，kiro-cli 2.15.0）

| 指标 | 均值 | min | max | 样本标准差 |
| --- | --- | --- | --- | --- |
| hit@5 | 92.6% | **88.9%** | 94.4% | 3.2% |
| hit@10 | 94.4% | 88.9% | 100% | 5.6% |
| R-precision | 65.7% | 63.9% | 69.4% | 3.2% |
| expected-empty 平均返回 | 6.00 | 5.50 | 6.50 | 0.50 |
| 关键事实召回 | 93.5% | 91.7% | 94.4% | 1.6% |
| memory_type 一致率 | 72.2% | 70.0% | 73.3% | 1.9% |
| 全门槛通过 | 2/3 次 | — | — | — |

**三次里有一次没过 hit@5 的 90% 门槛（88.9%）。** 这不是偶发噪声，而是样本量的直接后果：当时只有 18 条 relevance query，一条的得失就是 5.6 个百分点，17/18 = 94.4% 过、16/18 = 88.9% 挂。第四轮把 relevance 扩到 36 条（tuned 18 + heldout 18），单条权重降到 2.8 个百分点，门槛也按子集分开——但这份方差报告本身产出于扩样之前，其数字对应旧的 18 条。

结论只有一个诚实的写法：**单次 acp 运行跑绿不构成「质量已验证」**，它有约三分之一的概率只是运气。要让这条门槛真正稳定，需要扩大 relevance query 规模（把单条 query 的权重压到远小于门槛余量），而不是调低阈值。在那之前，对外引用 acp 数字必须带上运行次数与 `min`。

统计局限：目前 30 条 turn 里只有 5 条带未完成项，`next_steps` 召回的分母因此只有 5，单条漏报就是 20 个百分点，分辨力不足。后续扩充数据集时应优先提高这个分母。

## 已修复的缺陷

基准集的价值在于发现单元测试证明不了的问题。首轮（2026-07-27）发现两个，均已修复。

### D1 — FTS 对自然语言 query 召回恒为 0（已修复）

**问题**：`searchObservationsFts()` 把整个 query 包成一个 FTS5 字符串字面量，在 trigram 分词下等价于**严格子串匹配**：

```
"数据目录"                       -> 命中
"测试 数据目录"                  -> 0 命中（原文没有这个完整子串）
"跑测试会不会污染我真实的数据目录"  -> 0 命中
```

后果：首轮两次评估共 40 次检索，`match_source` **全部**是 `semantic`，FTS 一次都没贡献过候选。hybrid 检索实际退化成纯语义单路，RRF 融合形同虚设；embedding 不可用时的「降级 FTS-only」实际等于「召回归零」；hit@5 只有 72.2%（acp）/ 66.7%（gold），未达 90% 门槛。

这是 P0 3.1 修复（把 query 整体字面量化以修特殊字符崩溃）引入的副作用：崩溃修好了，多词与自然语言召回没了。

**修复**：`extractFtsSearchUnits()` 把 query 切成检索单元后 OR 连接，每个单元**各自**包成 FTS5 字符串字面量：

- 空白分隔的片段整体保留——`src/db/index.ts` 整体匹配远比它的碎片精确；
- 无空白的中日韩连续文字段额外按 3 字符滑动窗口切子串，因为中文没有词边界，整句子串匹配永远不成立；
- 单元数上限 32，避免病态 query 放大扫描；
- 没有任何 ≥3 字符单元时（低于 trigram 下限）退回 LIKE。

每个单元仍被双引号包裹，所以 `foo:bar`、`a-b`、未闭合引号、`AND`、`C++` 的字面量安全性不变。

效果：hit@5 gold 66.7% → 94.4%，acp 72.2% → 92.6% 均值（3 次运行，min 88.9% / max 94.4%）。注意 acp 的 min 仍在 90% 门槛之下——见上面「首次三次运行的实测结果」。

> 单元切分后来又改过一次：窗口预算改为**跨整段均匀采样**而不是从头部消耗。原来的头部优先会让一句无空格的长中文把预算全花在开头，尾部的区分词静默丢失（见 `plan/V3/open-risks-2026-07-27.md` P1-1）。预算不紧张时输出与旧行为一致。

### D2 — 成功的测试输出被误判为错误信号（已修复）

**问题**：`extractErrorText()` 对 `tool_response` 的 JSON 串做 `/\b(error|fail)/i` 匹配，因此：

```
tool_response = {"exit_status":0,"stdout":"138 pass, 0 fail"}
-> test_signals:  ["test PASS: 138 pass, 0 fail"]   ✅
-> error_signals: ["{\"exit_status\":0,\"stdout\":\"138 pass, 0 fail\"}"]   ❌
```

每个测试全绿的 turn 都会带一条假错误证据进压缩 prompt；读一个正好含 "error" 字样的文件也会让整轮被标记为出错。另外 `detectFileMutation()` 以 `hadError` 为门控，响应里恰好含 `fail`/`error` 字样的写文件调用会被误判为失败而丢掉文件变更事实。

**修复**：判定顺序改为「已知退出码优先」——`exit_status === 0` 直接判定成功并**停止**对正文做关键词猜测；非零退出码以 stderr 或状态本身为证据；其后依次看 `error` 字段与 `success === false`；对完全不上报状态的响应才退回关键词匹配，且 `0 fail` / `no errors` 这类否定计数会先被剔除再判断。
