<p align="center">
  <img src="../assets/logo.png" alt="kiro-mem logo" width="320" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/v/kiro-mem.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/dm/kiro-mem.svg" alt="npm downloads" /></a>
  <a href="https://github.com/GongTengXY/kiro-mem/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/kiro-mem.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
</p>

<p align="center">
  <a href="README.zh.md">🇨🇳 简体中文</a> | <a href="../../README.md">🇬🇧 English</a>
</p>

#### [Kiro CLI](https://kiro.dev) 的持久记忆系统

> 仅支持 Kiro CLI，不兼容 Kiro IDE。

[快速开始](#快速开始) • [工作原理](#工作原理) • [MCP 工具](#mcp-工具) • [配置](#配置) • [CLI 命令](#cli-命令) • [限制](#限制) • [许可证](#许可证)

---

kiro-mem 自动捕获 Kiro 会话中的每一轮对话（prompt → 工具调用 → stop），并将其压缩为一条不可变的 **Observation**——每个 closed turn 对应一条。它从不改写历史，也不在写入时猜测主题。会话开始时，它注入当前 workspace 历史工作的紧凑索引；Agent 先扫描这份"菜单"，再按需搜索、拉取完整详情。相关性组织发生在**读取时**，由 Agent 驱动，而非脆弱的写入期聚类。

**核心特性**

- 🧠 **持久记忆** — 跨会话保留项目上下文
- 🧩 **原子且不可变** — 一个 closed turn → 一条 Observation，文本永不改写或融合
- 🤖 **ACP 原生** — 压缩通过 Kiro CLI ACP 完成，无需配置 LLM API Key
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义召回，用 RRF 融合并按 workspace 硬隔离；词面零重叠的问法也能找回记录
- 📊 **读取期组织** — 先注入紧凑索引，Agent 按需拉取相关性（`search` → `timeline` → `get_observations`）
- 🔧 **MCP 工具** — `search`、`timeline`、`get_observations`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI 与运行时压缩提示词支持中英文

## 快速开始

需要 [Bun](https://bun.sh) 和支持 `acp` 子命令的 [Kiro CLI](https://kiro.dev)。

> **V3 与 V2 完全不兼容，唯一受支持的升级方式是清空重装。** 不提供数据库迁移，也没有兼容模式；在 V2 数据上直接装 V3 不受支持，也没有测试过。
>
> ```bash
> kiro-mem stop
> kiro-mem uninstall --purge   # ⚠️ 先看下面的警告
> npm i -g kiro-mem@3
> kiro-mem install
> ```
>
> ### ⚠️ `--purge` 会永久删除全部历史记忆与配置
>
> 它删除整个 `~/.kiro-mem`：所有采集到的 turn、所有 Observation、所有向量、任务队列、你的 `config.json` 以及本地 Worker token。**不可恢复，也没有导出功能。** 如果这些历史对你有价值，先把 `~/.kiro-mem` 复制到别处——但要知道 V2 的副本 V3 读不回来。
>
> 前面那句 `kiro-mem stop` 不是可选项：它避免旧 Worker 往一个正在被删除的目录里继续写。

首次安装：

```bash
npm i -g kiro-mem@3
kiro-mem install
```

安装器会检查 Kiro CLI ACP 可用性，生成仅当前用户可读写的高熵本地 Worker token，把内置的 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models/`，搭建隔离的 `kiro-runtime`（压缩子 agent + prompt），然后注册并启动 Worker。**无需任何 API Key** —— 记忆压缩通过 `kiro-cli acp` 复用 Kiro 已有的登录态完成。

如果 `kiro-runtime` 不完整（agent 文件缺失、prompt 缺失，或 `tools` 字段意外非空），Worker 启动时会立刻 fail-fast，不会带病运行而悄悄破坏压缩纯净性。重新执行 `kiro-mem install` 即可修复。

### 设为默认 Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

或在聊天中切换：

```text
/agent kiro-mem
```

### 验证安装

```bash
kiro-mem diagnose
kiro-mem status
curl http://127.0.0.1:37778/health
```

## 工作原理

**架构**

1. **核心真相层** — `session_id` → `turns` → `turn_events`（追加写入原始 hook payload）+ `turn_artifacts`（确定性提取：工具、文件、命令、测试/构建/lint 信号、错误）。该层永不改写，可重建任意投影。
2. **提炼层** — 持久任务（`summarize_turn` → `embed_observation`）驱动一个 **ACP runtime 池**：每次压缩都会向 `kiro-cli acp` 子进程发送 prompt，子进程内部跑的是 `tools: []` 的隔离 sub-agent `kiro-mem-compressor`。任何 tool-call 通知都视为污染，对应的 runtime 槽位会被立即回收。`summarize_turn` 消费用户 prompt、助手最终回复（`assistant_response`）与确定性 artifacts，对每个 closed turn 恰好写出一条不可变 Observation（按 `turn_id` 幂等）。它从不聚类、融合或 supersede。压缩失败时降级为 `quality=fallback` 的 Observation，只携带确定性证据——绝不虚构结果。
3. **检索层** — `observations_fts`（FTS5）与本地语义召回是两条**互相独立**的腿，用 RRF 融合并按 workspace 硬隔离 → MCP 工具 → 上下文注入。语义腿不需要关键词先命中才能跑：它可以召回 query 里一个字都没出现过的记录，边界是 cosine floor 与纯语义结果上限。

会话开始时，kiro-mem 为当前 workspace 注入一份紧凑的 **Observation 索引**：置顶观察、少数最近条目（附简短 outcome 片段）、以及更长的最近索引（每行带近似读取成本）。它是"菜单"而非正文——不做 LLM 合成，也没有主题。Agent 随后通过 `search` → `timeline` → `get_observations` 按需拉取相关性。

**数据模型**

- `session_refs` — 会话隔离元数据
- `turns` + `turn_events` — 每轮 prompt → stop 的生命周期行 + 追加写入的原始 hook payload（真相层）
- `turn_artifacts` — 确定性提取（工具、文件、命令、测试/构建/lint 信号、错误）
- `observations` — 不可变的按 turn 记忆单元：一个 closed turn → 一条 Observation，文本永不改写
- `observations_fts`（FTS5 trigram）+ `observation_embeddings` — 混合搜索的索引表
- `jobs` — 持久异步任务队列

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search` | 混合搜索观察，支持 `type`、`days`、`repo`/`cwd` 过滤 |
| `timeline` | 按真实 source-turn 顺序展示某条观察前后相邻的观察 |
| `get_observations` | 按 ID 获取观察完整详情，含来源 turn 元数据 |
| `pin` | 标记/取消标记某条观察供后续上下文使用 |

```text
@kiro-mem/search query="auth 模块 bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=42 before=3 after=3 mode="scope"
@kiro-mem/get_observations ids=[42,56]
```

`search` 通过 `computeScopeKey(repo, cwd)` 硬隔离到当前 workspace——传 `repo`/`cwd` 指定 scope，或传 `all_scopes: true` 浏览全部。`timeline` 以观察的**来源 turn**（而非其 ID）为锚点，因此相邻项反映真实工作时间线；传 `mode="session"` 可只看同一会话，而非整个 workspace。

**观察类型（`memory_type`）：** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## 隐私

使用 `<private>` 标签在存储前脱敏：

```text
<private>数据库密码是 xxx</private>
帮我配置连接
```

`<private>` 标签内的内容会在写入存储前替换为 `[REDACTED]`——覆盖用户 prompt、工具 payload 和助手最终回复，因此私密内容不会进入任何 Observation 或注入索引。

## 配置

编辑 `~/.kiro-mem/config.json`，或运行 `kiro-mem config` 交互式配置：

```json
{
  "language": "zh",
  "compression": {
    "concurrency": 3,
    "timeoutMs": 30000,
    "maxRetries": 2
  },
  "context": {
    "maxOutputBytes": 8192
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  },
  "retrieval": {
    "semanticDiscovery": true
  },
  "runtime": {
    "kiroHome": ""
  }
}
```

- `compression.concurrency`：并行运行的 `kiro-cli acp` 进程数（默认 `3`）。
- `compression.timeoutMs`：单次压缩超时（毫秒）。通过 `kiro-mem config` 修改时会限制在 `[5000, 60000]` 区间内（默认 `30000`）。
- `compression.maxRetries`：JSON 修复重试次数，超出后降级为 `quality=fallback` 的 Observation（默认 `2`）。
- `runtime.kiroHome`：压缩子 agent 使用的隔离 `KIRO_HOME`。空串时会回退到 `<dataDir>/kiro-runtime`，这是 `kiro-mem install` 默认布局。
- `context.maxOutputBytes`：注入 Observation 索引的字节预算，保持在 `agentSpawn` 的 10KB 上限之下（默认 `8192`）。
- `retrieval.semanticDiscovery`：语义相似度是否可以浮出关键词从未命中的记录（默认 `true`）。见下。

### 独立语义召回与回滚

`retrieval.semanticDiscovery: true` 是发布默认值：只要 `search` 带上合法的 `semantic_query_en`，即使当前 workspace 的 FTS 一条都没命中，语义腿也会照常执行——于是一个和记录用词完全不同的问法仍然能找回它。两道护栏防止它把页面填满看起来可信的噪声，两个数字都来自完整链路的参数扫描，不是凭手感定的：cosine floor `0.197`，以及**每次搜索最多 2 条纯语义结果**。只靠语义找到的结果标记为 `match_source: "semantic"`，据此行动前应当核实。

设为 `false` 就是回滚。它整份恢复此前的行为——必须有关键词锚点、floor `0.2`、纯语义结果无上限、平局按时间新旧——对编辑之后启动的 Kiro 会话生效：

```bash
# 回滚
kiro-mem config --show   # 查看当前生效的 profile
# 编辑 ~/.kiro-mem/config.json："retrieval": { "semanticDiscovery": false }
```

这个开关只改检索。它不动数据库 schema、不动已存向量、不动 embedding 协议，所以可以来回切换，不需要重建，也不会丢数据。

### 检索指标

`curl http://127.0.0.1:37778/health` 与 `kiro-mem diagnose` 会报出最近 24 小时的搜索计数。里面只有计数、枚举原因和延迟——没有 query 正文、Observation 正文或 workspace 路径。

| 字段（`search_24h`） | 含义 |
| --- | --- |
| `requests` / `latencyMsP50` / `latencyMsP95` | 搜索量与延迟。 |
| `protocolSemanticEn` / `semanticEnRate` | 真正跑在英文向量空间里的搜索占比。独立语义召回只在那个空间成立，所以这个比例低就意味着功能发布了但基本不可达。 |
| `semanticQueryIssues` | 英文形式为什么不可用，按原因分：`missing`（Agent 压根没传 `semantic_query_en`），以及 `untranslated`、`placeholder` 等护栏拒绝原因。 |
| `ftsOnly` / `degradeRate` | 因为拿不到 query 向量（Worker 挂了、超时）而退回纯关键词的搜索。降级是能力失败，不是策略选择。 |
| `zeroFts` / `zeroFtsRecalled` | 关键词一条都没命中的搜索数，以及其中仍然靠语义召回返回了结果的数量。这就是这个功能要抬起来的那个数字。 |
| `semanticOnlyTotal` / `semanticOnlyPerRequest` / `semanticOnlyMax` | 未核实的纯语义线索的量。`semanticOnlyMax` 永远不应超过 cap。 |
| `comparableVectors`（均值） | 语义腿实际能比对的已存向量数。被候选池（FTS 命中 ∪ scope 内最近 20,000 条）夹住，所以 scope 超过 20,000 条后会饱和。 |
| `scopeVectors`（均值 / 最小 / 测量到） | 整个搜索 scope 内该空间的向量数——不是候选池。"这个 workspace 到底建过这个协议的向量吗"只有这个数能回答。语义步骤没跑到时记 `null`，与 0 刻意区分。 |
| `emptyScopeRequests` | scope 内一条向量都没有的搜索数。非 0 说明这些请求的语义召回结构性不可能——是重建或任务积压问题，不是相关性问题。 |

`/health` 还会在 `retrieval` 下报出当前生效的 profile（每次调用都从磁盘读），所以"我的回滚生效了吗"不需要读代码就能回答。它报的是**下一个**会话会用的 profile——已经在跑的会话保持它启动时的那份。

## CLI 命令

```bash
kiro-mem install
kiro-mem status
kiro-mem start
kiro-mem stop
kiro-mem config
kiro-mem config --show
kiro-mem diagnose
kiro-mem repair
kiro-mem uninstall
kiro-mem uninstall --purge
```

## 系统要求

- **Bun**：最新版本
- **Kiro CLI**：**>= 2.3.0** —— 更早版本既没有 `acp` 子命令，也不支持隔离压缩子 agent 所依赖的 `KIRO_HOME` 覆盖。可通过 `kiro-cli --version` 与 `kiro-cli acp --help` 验证。
- **macOS / Linux**：Worker 保活需要 `launchd` / `systemd`

## 限制

| 限制 | 影响 | 缓解 |
|------|------|------|
| 采集是 best-effort | Hook 只给 Worker 约 700ms，且从不阻塞你的对话。Worker 重启或临时错误会丢掉原始事件，**丢掉的输入事后无法重建——记忆不保证完整** | 按 Hook 与原因计数；见 `/health` 的 `capture_misses_24h` 与 `kiro-mem diagnose` 的告警行 |
| 无细粒度删除 | 采集到的 turn 会无限期保留。`kiro-mem uninstall --purge` 清除**全部**数据；3.x **没有**按 Observation、按 scope、按时间段的删除，也没有导出与保留期策略 | 用 `<private>` 标签从源头阻止敏感内容入库 |
| 原始事件 payload 有上限 | 单个字符串字段超过 32KB 会被截断，单个 turn 最多存 4MB 原始 payload。截断会就地标记，但丢掉的字节不可恢复 | `payload_size` 仍记录原始大小；artifacts 提取在截断后的 payload 上继续工作 |
| 依赖 Kiro CLI ACP | `kiro-cli acp` 不可用时无法压缩 | `kiro-mem diagnose` 会跑 ACP smoke 测试 |
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 纯语义结果未经核实 | 词面零重叠的 query 现在能只靠语义找回记录，但这些结果的全部依据就是向量相似度；一个本项目从未做过的问题，仍然可能返回最多 2 条看起来很像的记录 | 它们标记为 `match_source: "semantic"`，每次搜索最多 2 条；据此行动前用 `get_observations` 或当前代码核实 |
| 独立召回依赖英文形式 | 语义腿只在 `semantic-en-v1` 空间里召回无锚点记录。Agent 没传 `semantic_query_en` 或护栏拒绝时，搜索退回"必须有关键词锚点"的旧行为 | `/health` 与 `kiro-mem diagnose` 的 `semanticEnRate`、`semanticQueryIssues` 会报出这件事发生的频率 |
| 语义召回上限为 20,000 条 | 语义腿给 FTS 命中加上 scope 内**最近 20,000 条** Observation 打分。这是原先 200 条的 100 倍，所以在小于该规模的 workspace 里旧记录都能被找到；但超过 20,000 条之后候选池会重新按 recency 截断，更早的记录仍可能压根没被打过分。全 scope 打分实测召回更好，但 50,000 条时需要约 720MB 工作内存（超过 512MB 预算），因此未发布 | 50,000 条下完整 search p95 实测 183ms（预算 300ms）。真正的修法——分块读取、立即打分、只保留有界 Top-K——留给后续独立轮次 |
| 安装阶段 | 把内置 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models` | 模型随包分发，无需下载模型 |
| 暂无 Web 查看器 | 通过 CLI/MCP/DB 查看记忆 | 单独规划中 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |

## 许可证

MIT
