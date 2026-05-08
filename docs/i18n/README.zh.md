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
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义重排
- 📊 **渐进式披露** — 先注入小索引，按需获取详情
- 🔧 **MCP 工具** — `search`、`get_memories`、`trace_memory`、`topics`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI 和压缩提示词支持中英文

## 快速开始

需要 [Bun](https://bun.sh) 和 [Kiro CLI](https://kiro.dev)。

```bash
npm i -g kiro-mem
kiro-mem install
```

安装器会询问语言、模型提供商、模型名称和 API Key，然后自动注册并启动 Worker。

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
2. **提炼层** — 持久任务：`summarize_turn` → `normalize_topic` → `merge_cluster_to_memory`
3. **检索层** — `memories_fts` + 语义重排 → MCP 工具 → 上下文注入

会话开始时，kiro-mem 注入按 **Pinned Memories**、**Active Topics**、**Recent Memories** 组织的紧凑记忆索引。Agent 可通过 MCP 工具按需搜索、查看和追溯记忆。

**数据模型**

- `session_refs` — 会话隔离元数据
- `turns` — 每轮 prompt → stop 为一条
- `turn_events` — 追加写入的原始 hook payload
- `memories` — 面向用户的记忆单元（turn 或 merged）
- `topics` — 归一化主题标签
- `jobs` — 持久异步任务队列

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search` | 混合搜索记忆，支持 `type`、`days`、`repo` 过滤 |
| `get_memories` | 按 ID 获取记忆完整详情 |
| `trace_memory` | 查看来源 turn 和相邻记忆 |
| `topics` | 浏览活跃主题和未完成事项 |
| `pin` | 标记/取消标记重要记忆 |

```text
@kiro-mem/search query="auth 模块 bug" type="bugfix" limit=10
@kiro-mem/trace_memory memory_id=42 before=3 after=3
@kiro-mem/get_memories ids=[42,56]
```

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
    "provider": "openai",
    "model": "gpt-5.4",
    "apiKey": "sk-proj-xxx",
    "concurrency": 6
  },
  "context": {
    "maxMemories": 50,
    "maxOutputBytes": 8192,
    "includePinned": true,
    "includeSummary": false
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  }
}
```

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
- **Kiro CLI**：需支持 hooks 和 agent 系统
- **macOS / Linux**：Worker 保活需要 `launchd` / `systemd`

## 限制

| 限制 | 影响 | 缓解 |
|------|------|------|
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 首次语义搜索 | 需下载本地 embedding 模型 | 下载后本地缓存 |
| 暂无 Web 查看器 | 通过 CLI/MCP/DB 查看记忆 | 单独规划中 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |
| 主题归一化 | 依赖 LLM，可能漂移 | 计划定期重新归一化 |

## 许可证

MIT
