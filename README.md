# kiro-memory

#### Persistent cross-session memory system for [Kiro CLI](https://kiro.dev).

> ⚠️ Kiro CLI only. Not compatible with Kiro IDE.

[Quick Start](#quick-start) • [How It Works](#how-it-works) • [MCP Search Tools](#mcp-search-tools) • [Configuration](#configuration) • [Management](#management) • [License](#license)

---

kiro-memory automatically captures tool call events during sessions, compresses them into structured memories via LLM, stores them in SQLite, and injects relevant historical context when a new session starts. It gives Kiro persistent awareness of your project across sessions.

**Key Features:**

- 🧠 **Persistent Memory** — Context automatically preserved across sessions
- ⚡ **LLM Compression** — Raw tool I/O compressed into structured observations via Anthropic / OpenAI / Ollama / any OpenAI-compatible API
- 🔍 **Full-Text Search** — SQLite FTS5 with trigram tokenizer for Chinese support
- 📊 **Smart Injection** — Recent session summaries auto-injected on session start, scoped by project/repo
- 🔧 **MCP Tools** — AI can proactively search historical memories during conversation
- 🚀 **Async Processing** — Background HTTP Worker + concurrent compression queue, zero blocking

## Quick Start

Requires [Bun](https://bun.sh) runtime and [Kiro CLI](https://kiro.dev).

### Option 1: npm Install (Recommended)

```bash
npx kiro-memory install
```

Follow the prompts to select an AI provider and enter your API key. Worker starts automatically after installation.

### Option 2: Install from Source

```bash
git clone https://github.com/GongTengXY/kiro-memory.git
cd kiro-memory
bun install
bun run scripts/setup.ts install
```

### Set as Default Agent

```bash
kiro-cli settings chat.defaultAgent kiro-memory
```

Every `kiro-cli chat` session will now have memory enabled. Or switch manually:

```bash
kiro-cli chat --agent kiro-memory
```

### Verify Installation

```bash
# Check Worker status
bun run scripts/setup.ts status

# Check Worker health
curl http://127.0.0.1:37778/health

# Test memory injection manually
echo '{"hook_event_name":"agentSpawn","cwd":"'$(pwd)'"}' | ~/.kiro-memory/hooks/context.sh
```

## How It Works

**Core Components:**

1. **4 Lifecycle Hooks** — agentSpawn, userPromptSubmit, postToolUse, stop
2. **Worker Service** — Bun HTTP server on port 37778 with async compression queue
3. **SQLite Database** — Stores sessions, observations, and summaries with FTS5 full-text index
4. **MCP Server** — stdio protocol, exposes search tools to AI

**Data Flow:**

```
Session Start
  → agentSpawn hook → Worker GET /context → Inject history into AI context

User Prompt
  → userPromptSubmit hook → Worker POST /events/prompt → Save to session

Tool Call
  → postToolUse hook → Worker POST /events/observation → Async LLM compression → Store

Session End
  → stop hook → Worker POST /events/stop → Generate session summary → Store
```

**Compression Pipeline:**

```
Raw tool I/O (1K-10K tokens)
  → LLM compression → Structured observation (~500 tokens)
  → Session end → Session summary (~300 tokens)
```

## MCP Search Tools

kiro-memory provides **2 MCP tools** following a token-efficient **two-layer retrieval pattern**:

1. **`search`** — Get compact index with IDs (~50-100 tokens/result)
2. **`get_observations`** — Fetch full details by ID (~500 tokens/result)

Filter first, then fetch details — **saves ~10x tokens**.

```
// Step 1: Search index
@kiro-memory/search query="auth module bug" type="bugfix" limit=10

// Step 2: Review results, pick relevant IDs

// Step 3: Fetch full details
@kiro-memory/get_observations ids=[123, 456]
```

**Observation Types:** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Kiro CLI                       │
│                                                  │
│  agentSpawn ──→ context.sh ──→ GET /context      │
│  userPromptSubmit ──→ prompt-save.sh ──→ POST    │
│  postToolUse ──→ observation.sh ──→ POST         │
│  stop ──→ summary.sh ──→ POST                    │
│                                                  │
│  AI Chat ──→ @kiro-memory/* (MCP)                │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Worker Service (Bun)                 │
│                                                  │
│  Compression Queue ──→ LLM API ──→ SQLite + FTS5 │
└─────────────────────────────────────────────────┘
```

**Storage:** `~/.kiro-memory/kiro-memory.db` (~36MB/year at 50 observations/day)

## Configuration

Edit `~/.kiro-memory/config.json`, or run `bun run scripts/setup.ts config` for interactive setup:

```json
{
  "compression": {
    "provider": "openai",
    "model": "gpt-5.4",
    "apiKey": "sk-proj-xxx",
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

**Supported Providers:**

| Provider    | Configuration                                   | API Key Required |
| ----------- | ----------------------------------------------- | :--------------: |
| `anthropic` | Default                                         |        ✅        |
| `openai`    | Set `provider` + `apiKey`                       |        ✅        |
| `ollama`    | Set `provider` + `baseUrl`                      |        ❌        |
| `custom`    | Any OpenAI-compatible API, set `baseUrl` + `apiKey` |    ✅        |

## Management

```bash
bun run scripts/setup.ts status       # Check Worker status
bun run scripts/setup.ts start        # Start Worker
bun run scripts/setup.ts stop         # Stop Worker
bun run scripts/setup.ts config       # Change compression model config
bun run scripts/setup.ts config --show # View current config
bun run scripts/setup.ts uninstall    # Uninstall (preserves database)
```

## System Requirements

- **Bun**: Latest version
- **Kiro CLI**: Must support hooks and agent system
- **SQLite 3**: Built into Bun (`bun:sqlite`)

## Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Runtime    | Bun                               |
| HTTP       | Hono                              |
| Database   | SQLite (bun:sqlite) + FTS5        |
| MCP Server | @modelcontextprotocol/sdk (stdio) |
| AI         | Anthropic SDK / OpenAI-compatible |

## Known Limitations

| Limitation                    | Impact                              | Mitigation                              |
| ----------------------------- | ----------------------------------- | --------------------------------------- |
| No session ID in hooks        | Cannot precisely map Kiro sessions  | Inferred via cwd + 30min time window    |
| agentSpawn output limit 10KB  | History summary size is capped      | Summaries kept under 8KB               |
| AI compression has cost       | Depends on model choice             | Configurable provider, supports Ollama  |
| Chinese FTS < 3 chars         | Short Chinese words use LIKE fallback | Observations include bilingual concepts |
| Local only                    | No cross-machine sync               | Future: git sync or cloud storage       |

## License

MIT
