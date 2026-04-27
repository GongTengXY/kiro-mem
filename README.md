<p align="center">
  <img src="docs/assets/logo.png" alt="kiro-mem logo" width="320" />
</p>

[🇨🇳 中文](docs/i18n/README.zh.md)

#### Persistent memory system for [Kiro CLI](https://kiro.dev).

> Kiro CLI only. Not compatible with Kiro IDE.

[Quick Start](#quick-start) • [How It Works](#how-it-works) • [MCP Search Tools](#mcp-search-tools) • [Configuration](#configuration) • [CLI](#cli) • [Limitations](#limitations) • [License](#license)

---

kiro-mem automatically captures prompts and tool-call history during Kiro sessions, compresses them into structured memories, and injects a compact memory index into later sessions. The agent scans the index first, then fetches details only when needed.

**Key Features**

- 🧠 **Persistent Memory** — Keep project context across sessions
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic reranking
- 📊 **Progressive Disclosure** — Inject a small index first, fetch details on demand
- 🔧 **MCP Tools** — `search`, `get_observations`, `timeline`, `pin`
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Background compression queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for CLI and compression prompts

## Quick Start

Requires [Bun](https://bun.sh) and [Kiro CLI](https://kiro.dev).

```bash
npm i -g kiro-mem
kiro-mem install
```

The installer will ask for language, model provider, model name, and API key, then register and start the Worker automatically.

### Set As Default Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

Or switch inside a chat session:

```text
/agent kiro-mem
```

### Verify Installation

```bash
kiro-mem diagnose
kiro-mem status
curl http://127.0.0.1:37778/health
```

## How It Works

**Core Components**

1. **4 Lifecycle Hooks** — `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`
2. **Worker Service** — Bun HTTP server on port `37778` with async compression queue
3. **SQLite Database** — Stores sessions, observations, summaries, and embeddings
4. **MCP Server** — Exposes 4 retrieval tools over stdio
5. **Local Embeddings** — `all-MiniLM-L6-v2` for semantic reranking

At session start, kiro-mem injects a compact observation index. The agent can then use MCP tools to search history, inspect nearby context, and fetch full details only for relevant memories.

## MCP Search Tools

kiro-mem follows a simple three-layer retrieval flow:

1. **Search the index** with `search`
2. **Inspect local context** with `timeline`
3. **Fetch full details** with `get_observations`

`pin` marks important observations so they are prioritized in future context injection.

| Tool               | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `search`           | Hybrid search with `type`, `days`, and `repo` filters |
| `get_observations` | Fetch full observation details by ID                  |
| `timeline`         | Show observations before and after a target item      |
| `pin`              | Mark or unmark important memories                     |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=123 before=5 after=5
@kiro-mem/get_observations ids=[123,456]
```

**Observation Types:** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Privacy

Use `<private>` tags to redact sensitive content before storage:

```text
<private>database password is xxx</private>
Help me configure the connection
```

Content inside `<private>` tags is replaced with `[REDACTED]` before it is written to memory.

## Configuration

Edit `~/.kiro-mem/config.json`, or run `kiro-mem config` for interactive setup:

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

**Common Settings**

- `language`: `zh` or `en`
- `compression.provider`: `anthropic`, `openai`, `ollama`, or `custom`
- `context.*`: controls how much memory is injected on session start
- `includePinned`: show pinned memories first

## CLI

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

## System Requirements

- **Bun**: Latest version
- **Kiro CLI**: Must support hooks and agent system
- **macOS / Linux**: Required for Worker keepalive via `launchd` / `systemd`

## Limitations

| Limitation                          | Impact                                          | Mitigation                                         |
| ----------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| No session ID in hooks              | Session matching is approximate                 | Inferred with `cwd` + 30-minute activity window    |
| `agentSpawn` output limit 10KB      | Injected index must stay compact                | Default settings usually stay well below the limit |
| Search queries shorter than 3 chars | Falls back to `LIKE`, less precise              | Use longer terms when possible                     |
| First semantic-search use           | Downloads local embedding model once            | Cached locally after first use                     |
| No Web Viewer UI yet                | Memory can only be inspected through CLI/MCP/DB | Planned separately from the core memory flow       |
| Local only                          | No built-in cross-machine sync                  | Future: git sync or cloud storage                  |

## License

MIT
