<p align="center">
  <img src="../../docs/assets/logo.png" alt="kiro-mem logo" width="120" />
</p>

[🇬🇧 English](../../README.md)

#### [Kiro CLI](https://kiro.dev) 的持久化记忆系统。

> 仅支持 Kiro CLI，不兼容 Kiro IDE。

[快速开始](#快速开始) • [工作原理](#工作原理) • [MCP 搜索工具](#mcp-搜索工具) • [配置](#配置) • [CLI 命令](#cli-命令) • [局限性](#局限性) • [许可证](#许可证)

---

kiro-mem 在 Kiro 会话期间自动捕获提示词和工具调用历史，将其压缩为结构化记忆，并在后续会话中注入紧凑的记忆索引。Agent 会先扫描索引，仅在需要时获取详细内容。

**核心特性**

- 🧠 **持久化记忆** — 跨会话保留项目上下文
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义重排序
- 📊 **渐进式披露** — 先注入小型索引，按需获取详情
- 🔧 **MCP 工具** — `search`、`get_observations`、`timeline`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 后台压缩队列，不阻塞工具调用
- 🔄 **进程保活** — 通过 `launchd` 或 `systemd` 管理 Worker
- 🌐 **国际化** — CLI 和压缩提示词支持 `zh` 和 `en`

## 快速开始

需要 [Bun](https://bun.sh) 和 [Kiro CLI](https://kiro.dev)。

```bash
npm i -g kiro-mem
kiro-mem install
```

安装程序会询问语言、模型提供商、模型名称和 API Key，然后自动注册并启动 Worker。

### 设为默认 Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

或在聊天会话中切换：

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

**核心组件**

1. **4 个生命周期钩子** — `agentSpawn`、`userPromptSubmit`、`postToolUse`、`stop`
2. **Worker 服务** — 运行在端口 `37778` 的 Bun HTTP 服务器，带异步压缩队列
3. **SQLite 数据库** — 存储会话、观察记录、摘要和嵌入向量
4. **MCP 服务器** — 通过 stdio 暴露 4 个检索工具
5. **本地嵌入模型** — `all-MiniLM-L6-v2` 用于语义重排序

会话启动时，kiro-mem 注入紧凑的观察记录索引。Agent 随后可使用 MCP 工具搜索历史、查看上下文、仅获取相关记忆的完整详情。

## MCP 搜索工具

kiro-mem 遵循简单的三层检索流程：

1. 使用 `search` **搜索索引**
2. 使用 `timeline` **查看上下文**
3. 使用 `get_observations` **获取完整详情**

`pin` 可标记重要的观察记录，使其在未来的上下文注入中优先展示。

| 工具               | 用途                                       |
| ------------------ | ------------------------------------------ |
| `search`           | 混合搜索，支持 `type`、`days`、`repo` 过滤 |
| `get_observations` | 按 ID 获取观察记录完整详情                 |
| `timeline`         | 显示目标记录前后的观察记录                 |
| `pin`              | 标记或取消标记重要记忆                     |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=123 before=5 after=5
@kiro-mem/get_observations ids=[123,456]
```

**观察记录类型：** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## 隐私

使用 `<private>` 标签在存储前脱敏：

```text
<private>数据库密码是 xxx</private>
帮我配置连接
```

`<private>` 标签内的内容在写入记忆前会被替换为 `[REDACTED]`。

## 配置

编辑 `~/.kiro-mem/config.json`，或运行 `kiro-mem config` 进行交互式配置：

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
    "maxObservations": 50,
    "maxSessions": 10,
    "fullCount": 5,
    "fullField": "narrative",
    "maxOutputBytes": 8192,
    "includePinned": true,
    "includeSummary": false
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  }
}
```

**常用设置**

- `language`：`zh` 或 `en`
- `compression.provider`：`anthropic`、`openai`、`ollama` 或 `custom`
- `context.*`：控制会话启动时注入多少记忆
- `includePinned`：优先显示已标记的记忆

## CLI 命令

```bash
kiro-mem install       # 安装
kiro-mem status        # 查看状态
kiro-mem start         # 启动 Worker
kiro-mem stop          # 停止 Worker
kiro-mem config        # 交互式配置
kiro-mem config --show # 查看当前配置
kiro-mem diagnose      # 诊断
kiro-mem uninstall     # 卸载
kiro-mem uninstall --purge  # 卸载并清除数据
```

## 系统要求

- **Bun**：最新版本
- **Kiro CLI**：需支持钩子和 Agent 系统
- **macOS / Linux**：Worker 保活需要 `launchd` / `systemd`

## 局限性

| 局限                       | 影响                         | 缓解方案                         |
| -------------------------- | ---------------------------- | -------------------------------- |
| 钩子中无 session ID        | 会话匹配为近似匹配           | 通过 `cwd` + 30 分钟活动窗口推断 |
| `agentSpawn` 输出限制 10KB | 注入索引必须保持紧凑         | 默认设置通常远低于限制           |
| 搜索词少于 3 个字符        | 回退到 `LIKE`，精度较低      | 尽量使用更长的搜索词             |
| 首次语义搜索               | 需下载本地嵌入模型一次       | 首次使用后本地缓存               |
| 暂无 Web 查看器            | 只能通过 CLI/MCP/DB 查看记忆 | 计划单独开发                     |
| 仅限本地                   | 无内置跨机器同步             | 未来：git 同步或云存储           |

## 许可证

MIT
