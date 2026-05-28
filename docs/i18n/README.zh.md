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

kiro-mem 自动捕获 Kiro 会话中的每一轮对话（prompt → 工具调用 → stop），将其压缩为结构化**记忆**，按**主题**组织，并在后续会话中注入紧凑的记忆索引。Agent 先扫描索引，按需获取详情。

**核心特性**

- 🧠 **持久记忆** — 跨会话保留项目上下文
- 🤖 **ACP 原生** — 压缩通过 Kiro CLI ACP 完成，无需配置 LLM API Key
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义重排
- 📊 **渐进式披露** — 先注入小索引，按需获取详情
- 🔧 **MCP 工具** — `search`、`get_memories`、`trace_memory`、`topics`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI 与运行时压缩提示词支持中英文

## 快速开始

需要 [Bun](https://bun.sh) 和支持 `acp` 子命令的 [Kiro CLI](https://kiro.dev)。

```bash
npm i -g kiro-mem
kiro-mem install
```

安装器会检查 Kiro CLI ACP 可用性，把内置的 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models/`，搭建隔离的 `kiro-runtime`（压缩子 agent + prompt），然后注册并启动 Worker。**无需任何 API Key** —— 记忆压缩通过 `kiro-cli acp` 复用 Kiro 已有的登录态完成。

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

**架构（V2 Turn+）**

1. **真相层** — `session_id` → `turns` → `turn_events`（追加写入原始 payload）
2. **提炼层** — 持久任务（`summarize_turn` → `normalize_topic` → `summarize_topic` / `merge_cluster_to_memory`）驱动一个 **ACP runtime 池**：每次压缩都会向 `kiro-cli acp` 子进程发送 prompt，子进程内部跑的是 `tools: []` 的隔离 sub-agent `kiro-mem-compressor`。任何 tool-call 通知都视为污染，对应的 runtime 槽位会被立即回收。`normalize_topic` 会先做一次确定性预匹配（仅做 case/whitespace/末尾标点归一），匹不上才回退到模型；`summarize_topic` 在 topic memory_count 跨过 3/5/10/20，或每次 merge 完成后入队，确保 Active Topics 始终反映当前记忆集合。
3. **检索层** — `memories_fts` + 语义重排 → MCP 工具 → 上下文注入

会话开始时，kiro-mem 注入按 **Pinned Memories**、**Active Topics**、**Recent Memories** 组织的紧凑记忆索引。Agent 可通过 MCP 工具按需搜索、查看和追溯记忆。

**数据模型**

- `session_refs` — 会话隔离元数据
- `turns` + `turn_events` — 每轮 prompt → stop 的生命周期行 + 追加写入的原始 hook payload（真相层）
- `turn_artifacts` — 确定性提取（工具名、文件、命令、错误信号）
- `memories` + `memory_turn_links` — 面向用户的记忆单元（turn 或 merged）以及它们的来源 turn 指针
- `topics` — 归一化主题标签，含 `summary` / `unresolved_summary`
- `memories_fts`（FTS5 trigram）+ `memory_embeddings` — 混合搜索的索引表
- `jobs` — 持久异步任务队列

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search` | 混合搜索记忆，支持 `type`、`days`、`repo` 过滤 |
| `get_memories` | 按 ID 获取记忆完整详情 |
| `trace_memory` | 查看来源 turn 和相邻记忆 |
| `topics` | 浏览活跃主题 |
| `pin` | 标记/取消标记重要记忆 |

```text
@kiro-mem/search query="auth 模块 bug" type="bugfix" limit=10
@kiro-mem/trace_memory memory_id=42 before=3 after=3
@kiro-mem/get_memories ids=[42,56]
@kiro-mem/topics cwd="/path/to/non-git-project"
```

`topics` 接受可选的 `cwd` 参数，让非 git 项目即使共享 `NULL` repo 也能彼此隔离。传 `repo` 按 git root 过滤，传 `cwd` 按工作目录过滤，两者都不传则浏览全部。

**记忆类型：** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## 隐私

使用 `<private>` 标签在存储前脱敏：

```text
<private>数据库密码是 xxx</private>
帮我配置连接
```

`<private>` 标签内的内容会在写入记忆前替换为 `[REDACTED]`。

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
    "maxMemories": 50,
    "maxOutputBytes": 8192,
    "includePinned": true,
    "includeSummary": false
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  },
  "runtime": {
    "kiroHome": ""
  }
}
```

- `compression.concurrency`：并行运行的 `kiro-cli acp` 进程数（默认 `3`）。
- `compression.timeoutMs`：单次压缩超时（毫秒）。通过 `kiro-mem config` 修改时会限制在 `[5000, 60000]` 区间内（默认 `30000`）。
- `compression.maxRetries`：JSON 修复重试次数，超出后回退到 stub memory（默认 `2`）。
- `runtime.kiroHome`：压缩子 agent 使用的隔离 `KIRO_HOME`。空串时会回退到 `<dataDir>/kiro-runtime`，这是 `kiro-mem install` 默认布局。
- `context.includeSummary`：设为 `true` 时，注入的 Recent Memories 每条会额外带一行 summary 截断。每条体积约为原来的 3 倍，因此 kiro-mem 会自动把条数上限收紧到 20 条，以避免突破 agentSpawn 的字节预算。

## CLI 命令

```bash
kiro-mem install
kiro-mem status
kiro-mem start
kiro-mem stop
kiro-mem config
kiro-mem config --show
kiro-mem diagnose
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
| 依赖 Kiro CLI ACP | `kiro-cli acp` 不可用时无法压缩 | `kiro-mem diagnose` 会跑 ACP smoke 测试 |
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 安装阶段 | 把内置 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models` | 完全本地，安装后无需联网 |
| 暂无 Web 查看器 | 通过 CLI/MCP/DB 查看记忆 | 单独规划中 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |
| 主题归一化 | 依赖 LLM，可能漂移 | 后期会补充定期重新归一化 |

## 许可证

MIT
