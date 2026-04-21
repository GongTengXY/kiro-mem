# kiro-memory

#### 为 [Kiro CLI](https://kiro.dev) 打造的跨会话持久记忆系统。

> ⚠️ 仅支持 Kiro CLI，不兼容 Kiro IDE。

[快速开始](#快速开始) • [工作原理](#工作原理) • [MCP 搜索工具](#mcp-搜索工具) • [配置](#配置) • [管理](#管理) • [许可证](#许可证)

---

kiro-memory 自动捕获会话中的工具调用事件，通过 LLM 压缩为结构化记忆，存入 SQLite，并在新会话启动时自动注入相关历史上下文。让 Kiro 在会话结束后依然保持对项目的持续认知。

**核心特性：**

- 🧠 **持久记忆** — 上下文自动跨会话保留
- ⚡ **LLM 压缩** — 原始工具 I/O 经 Anthropic / OpenAI / Ollama / 任意 OpenAI 兼容 API 压缩为结构化观察记录
- 🔍 **全文检索** — SQLite FTS5，支持中文 trigram 分词
- 📊 **智能注入** — 会话启动时自动注入同项目/同 repo 的最近历史摘要
- 🔧 **MCP 工具** — AI 可在对话中主动搜索历史记忆
- 🚀 **异步处理** — 后台 HTTP Worker + 并发压缩队列，零阻塞

## 快速开始

需要 [Bun](https://bun.sh) 运行时。

```bash
git clone https://github.com/GongTengXY/kiro-memory.git
cd kiro-memory
bun install
bun run scripts/setup.ts install
```

设置 API Key 和默认 Agent：

```bash
export ANTHROPIC_API_KEY=sk-...
kiro-cli settings chat.defaultAgent kiro-memory
```

重启 Kiro CLI，历史会话上下文将自动出现在新会话中。

## 工作原理

**核心组件：**

1. **4 个生命周期 Hook** — agentSpawn、userPromptSubmit、postToolUse、stop
2. **Worker 服务** — Bun HTTP 服务，端口 37778，内置异步压缩队列
3. **SQLite 数据库** — 存储会话、观察记录、摘要，带 FTS5 全文索引
4. **MCP Server** — 基于 stdio 协议，向 AI 暴露搜索工具

**数据流：**

```
会话启动
  → agentSpawn hook → Worker GET /context → 注入历史摘要到 AI 上下文

用户提问
  → userPromptSubmit hook → Worker POST /events/prompt → 保存到会话

工具调用
  → postToolUse hook → Worker POST /events/observation → 异步 LLM 压缩 → 存储

会话结束
  → stop hook → Worker POST /events/stop → 生成会话摘要 → 存储
```

**压缩流水线：**

```
原始工具 I/O (1K-10K tokens)
  → LLM 压缩 → 结构化观察记录 (~500 tokens)
  → 会话结束 → 会话摘要 (~300 tokens)
```

## MCP 搜索工具

kiro-memory 提供 **2 个 MCP 工具**，遵循 token 高效的**两层检索模式**：

1. **`search`** — 获取紧凑索引，含 ID（~50-100 tokens/条）
2. **`get_observations`** — 按 ID 获取完整详情（~500 tokens/条）

先筛选再获取详情，**节省约 10 倍 token**。

```
// 第 1 步：搜索索引
@kiro-memory/search query="认证模块 bug" type="bugfix" limit=10

// 第 2 步：查看结果，挑选相关 ID

// 第 3 步：获取完整详情
@kiro-memory/get_observations ids=[123, 456]
```

**观察记录类型：** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## 架构

```
┌─────────────────────────────────────────────────┐
│                   Kiro CLI                       │
│                                                  │
│  agentSpawn ──→ context.sh ──→ GET /context      │
│  userPromptSubmit ──→ prompt-save.sh ──→ POST    │
│  postToolUse ──→ observation.sh ──→ POST         │
│  stop ──→ summary.sh ──→ POST                    │
│                                                  │
│  AI 对话 ──→ @kiro-memory/* (MCP)                │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Worker 服务 (Bun)                    │
│                                                  │
│  压缩队列 ──→ LLM API ──→ SQLite + FTS5          │
└─────────────────────────────────────────────────┘
```

**存储位置：** `~/.kiro-memory/kiro-memory.db`（按每天 50 条观察记录估算，约 36MB/年）

## 配置

编辑 `~/.kiro-memory/config.json`：

```json
{
  "compression": {
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "concurrency": 6
  },
  "context": {
    "maxSessions": 10,
    "maxOutputBytes": 8192
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-memory/*"]
  }
}
```

**支持的 Provider：**

| Provider    | 配置方式                                        | 需要 API Key |
| ----------- | ----------------------------------------------- | :----------: |
| `anthropic` | 默认                                            |      ✅      |
| `openai`    | 设置 `provider` + `apiKey`                      |      ✅      |
| `ollama`    | 设置 `provider` + `baseUrl`                     |      ❌      |
| `custom`    | 任意 OpenAI 兼容 API，设置 `baseUrl` + `apiKey` |      ✅      |

## 管理

```bash
bun run scripts/setup.ts status     # 查看 Worker 状态
bun run scripts/setup.ts start      # 启动 Worker
bun run scripts/setup.ts stop       # 停止 Worker
bun run scripts/setup.ts uninstall  # 卸载（保留数据库）
```

## 系统要求

- **Bun**：最新版本
- **Kiro CLI**：需支持 hooks 和 agent 机制
- **SQLite 3**：Bun 内置（`bun:sqlite`）

## 技术栈

| 层         | 技术                              |
| ---------- | --------------------------------- |
| 运行时     | Bun                               |
| HTTP 服务  | Hono                              |
| 数据库     | SQLite (bun:sqlite) + FTS5        |
| MCP Server | @modelcontextprotocol/sdk (stdio) |
| AI 压缩    | Anthropic SDK / OpenAI 兼容 API   |

## 已知限制

| 限制                     | 影响                           | 缓解方案                         |
| ------------------------ | ------------------------------ | -------------------------------- |
| Hook 中无 session ID     | 无法精确映射 Kiro 会话         | 通过 cwd + 30 分钟时间窗口推断   |
| agentSpawn 输出上限 10KB | 注入的历史摘要有大小限制       | 摘要控制在 8KB 以内              |
| AI 压缩有成本            | Haiku ~$0.05/天，Opus ~$3.5/天 | 可配置 provider，支持本地 Ollama |
| 中文 FTS < 3 字符        | 短中文词走 LIKE 回退           | 观察记录中同时包含中英文概念标签 |
| 仅限本地                 | 无跨机器同步                   | 未来计划：git 同步或云存储       |

## 许可证

MIT
