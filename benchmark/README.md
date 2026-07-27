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

评估全程使用临时数据目录与临时 SQLite，**不读写开发者真实 `~/.kiro-mem`**。ACP 模式例外地只读引用真实 `<dataDir>/kiro-runtime`，以复用已安装的压缩子 Agent。

## 两种压缩器

| 模式 | 用途 |
| --- | --- |
| `gold` | 直接返回人工标注。用于（a）在没有 kiro-cli 的环境里建立可重复的检索基线；（b）自检打分器——gold 跑出来的摘要类指标必须接近满分，否则是打分器有 bug 而不是系统有 bug。 |
| `acp` | 走真实 `kiro-cli acp` 子进程与生产 prompt，测量真实摘要质量。 |

两种模式都复用**生产合成链路**：`createApp()` 注册的 `summarize_turn` / `embed_observation` job、`hybridSearchObservations()`、`buildBootstrapContext()`。评估脚本不复制任何生产逻辑。

## 数据集

`dataset/turns.json` — 30 个标注 turn（primary 26 / other 4），取材于本仓库 V3 的真实开发历史（提交记录、发布评审清单、实际测试输出），人工标注并脱敏。4 条 `scope: "other"` 属于另一个 workspace，**故意与主 scope 共用词汇**（token/401/search/超时），用来检验 scope 硬隔离而不是词汇差异。

每条包含：

| 字段 | 含义 |
| --- | --- |
| `prompt` / `assistant_response` | 真实的用户请求与助手最终回复 |
| `events[]` | 要回放的工具事件，形状与 `postToolUse` hook 的 payload 一致 |
| `annotation.completed` | 这一轮是否真的做完 |
| `annotation.key_files` | 关键文件，应出现在 `Observation.files_touched` |
| `annotation.key_facts` | **可核对事实标记**，应逐字出现在 Observation 正文（如 `138 pass`、`0600`、`384`） |
| `annotation.unfinished` | 未完成项；非空时 `next_steps` 必须非空，空时必须为空 |
| `annotation.forbidden_claims` | 不允许出现的断言，用于检测虚构完成状态 |
| `annotation.title/summary/outcome/learned/concepts` | 人工参考 Observation，`gold` 模式直接返回它 |

`dataset/queries.json` — 20 个标注 query（relevance 18 / leakage 2）。`kind: "leakage"` 的 query 只用另一个 workspace 的词汇，期望主 scope 检索返回 0 条跨 scope 结果。泄漏检查对**所有** query 生效，不只是这两条。

## 指标与门槛

| 门槛 | 阈值 | 依据 |
| --- | --- | --- |
| Top-5 至少一条标注 Observation 命中 | ≥ 90% | §12.3「search 对标注 query 的 Top-K 中至少一条有直接帮助」 |
| 跨 workspace 检索泄漏 | = 0 | §12.3 Scope 隔离 |
| 跨 workspace bootstrap 注入 | = 0 | §12.3 Scope 隔离 |
| outcome 非空率 | ≥ 90% | §12.3 Summary 完整性 |
| next_steps 未完成项召回 | ≥ 85% | §12.3「next step 缺失率」 |
| 关键事实逐字召回 | ≥ 80% | §12.3 事实准确性 |
| 关键文件召回 | ≥ 80% | §12.3 事实准确性 |
| 虚构完成断言 turn 数 | = 0 | §6.5 outcome 必须与证据一致 |
| 幻觉文件 turn 数 | = 0 | 只有本轮任何证据里都没出现过的路径才算幻觉 |
| search p95 | < 300ms | §12.3 Hook 延迟 |
| bootstrap 构建 | < 100ms 且在字节预算内 | §7.3 |

两个只报告、不设门槛的参考项：

- **`memory_type` 与标注一致率**：粗分类，`feature`/`bugfix`/`refactor` 之间存在合理分歧。
- **`next_steps` 过度生成率**：标注无未完成项但模型仍写了 `next_steps`。§12.3 关心的是「缺失率」，即有未完成项却没写出来；反向的过度生成危害小得多，单独统计。

### 两条口径说明

**事实标记比较前去掉空白。** `58fps` 与 `58 fps` 是同一个事实，不该因排版差异算缺失。

**标注的未完成项必须在 turn 输入里有依据。** 首轮数据集里 t16、t17 犯了这个错：`annotation.unfinished` 写了待办，但 `assistant_response` 和工具证据里没有任何「还没做」的表述——那个待办来自发布评审文档而不是这一轮对话。要求压缩器在这种输入下产出 `next_steps`，等于要求它虚构，而虚构本身是另一条门槛在惩罚的行为。两条已修正为忠实输入。**新增标注时必须自检这一点。**

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

效果：hit@5 gold 66.7% → 94.4%，acp 72.2% → 94.4%~100%（LLM 有轮次波动）。

### D2 — 成功的测试输出被误判为错误信号（已修复）

**问题**：`extractErrorText()` 对 `tool_response` 的 JSON 串做 `/\b(error|fail)/i` 匹配，因此：

```
tool_response = {"exit_status":0,"stdout":"138 pass, 0 fail"}
-> test_signals:  ["test PASS: 138 pass, 0 fail"]   ✅
-> error_signals: ["{\"exit_status\":0,\"stdout\":\"138 pass, 0 fail\"}"]   ❌
```

每个测试全绿的 turn 都会带一条假错误证据进压缩 prompt；读一个正好含 "error" 字样的文件也会让整轮被标记为出错。另外 `detectFileMutation()` 以 `hadError` 为门控，响应里恰好含 `fail`/`error` 字样的写文件调用会被误判为失败而丢掉文件变更事实。

**修复**：判定顺序改为「已知退出码优先」——`exit_status === 0` 直接判定成功并**停止**对正文做关键词猜测；非零退出码以 stderr 或状态本身为证据；其后依次看 `error` 字段与 `success === false`；对完全不上报状态的响应才退回关键词匹配，且 `0 fail` / `no errors` 这类否定计数会先被剔除再判断。
