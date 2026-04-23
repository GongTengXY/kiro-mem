# kiro-mem

#### Persistent cross-session memory system for [Kiro CLI](https://kiro.dev).

> ⚠️ Kiro CLI only. Not compatible with Kiro IDE.

[Quick Start](#quick-start) • [How It Works](#how-it-works) • [MCP Search Tools](#mcp-search-tools) • [Configuration](#configuration) • [Management](#management) • [License](#license)

---

kiro-mem automatically captures tool call events during sessions, compresses them into structured memories via LLM, stores them in SQLite, and injects a compact memory index when a new session starts. AI scans the index and fetches details on-demand, giving Kiro persistent awareness of your project across sessions.

**Key Features:**

- 🧠 **Persistent Memory** — Context automatically preserved across sessions
- ⚡ **LLM Compression** — Raw tool I/O compressed into structured observations via Anthropic / OpenAI / Ollama / any OpenAI-compatible API
- 🔍 **Full-Text Search** — SQLite FTS5 with trigram tokenizer for Chinese support
- 📊 **Progressive Disclosure** — Compact observation index auto-injected on session start; AI fetches details on-demand via MCP tools
- 🔧 **MCP Tools** — 4 tools (search, get_observations, timeline, pin) for three-layer retrieval
- 🔒 **Privacy Control** — Use `<private>` tags to exclude sensitive content from storage
- 🚀 **Async Processing** — Background HTTP Worker + concurrent compression queue, zero blocking

## Quick Start

Requires [Bun](https://bun.sh) runtime and [Kiro CLI](https://kiro.dev).

```bash
npm i -g kiro-mem
kiro-mem install
```

Follow the prompts to select an AI provider and enter your API key. Worker starts automatically after installation.

### Set as Default Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

Every `kiro-cli chat` session will now have memory enabled. Or switch manually:

```bash
kiro-cli chat --agent kiro-mem
```

### Verify Installation

```bash
# Check Worker status
kiro-mem status

# Check Worker health
curl http://127.0.0.1:37778/health

# Test memory injection manually
echo '{"hook_event_name":"agentSpawn","cwd":"'$(pwd)'"}' | ~/.kiro-mem/hooks/context.sh
```

## How It Works

**Core Components:**

1. **4 Lifecycle Hooks** — agentSpawn, userPromptSubmit, postToolUse, stop
2. **Worker Service** — Bun HTTP server on port 37778 with async compression queue
3. **SQLite Database** — Stores sessions, observations, and summaries with FTS5 full-text index
4. **MCP Server** — stdio protocol, exposes 4 search tools to AI

**Data Flow:**

```
Session Start
  → agentSpawn hook → Worker GET /context → Inject observation index into AI context

User Prompt
  → userPromptSubmit hook → Worker POST /events/prompt → Save to session

Tool Call
  → postToolUse hook → Worker POST /events/observation → Async LLM compression → Store

Session End
  → stop hook → Worker POST /events/stop → Generate session summary → Store
```

**Context Injection (Progressive Disclosure):**

```
Session Start injects:
  📌 Pinned observations (index rows)
  📝 Recent N observations (expanded with narrative)
  📋 Remaining observations (grouped by file path, index rows only)
  💡 Legend + MCP tool usage hints

AI decides:
  → Scan titles, skip irrelevant ones
  → Fetch details via @kiro-mem/get_observations for relevant IDs
  → Explore context via @kiro-mem/timeline
```

**Compression Pipeline:**

```
Raw tool I/O (1K-10K tokens)
  → LLM compression → Structured observation (~500 tokens)
  → Session end → Session summary (~300 tokens)
```

## MCP Search Tools

kiro-mem provides **4 MCP tools** following a token-efficient **three-layer retrieval pattern**:

1. **`search`** — Search memory index with full-text queries, filters by type/date/repo (~50-100 tokens/result)
2. **`get_observations`** — Fetch full observation details by IDs (~500 tokens/result)
3. **`timeline`** — Get chronological context around a specific observation
4. **`pin`** — Mark/unmark observations as important; pinned memories are prioritized in context injection

Filter first, then fetch details — **saves ~10x tokens**.

```
// Layer 1: Search index
@kiro-mem/search query="auth module bug" type="bugfix" limit=10

// Layer 2: Review results, explore context
@kiro-mem/timeline observation_id=123 before=5 after=5

// Layer 3: Fetch full details for relevant IDs
@kiro-mem/get_observations ids=[123, 456]
```

**Observation Types:** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Privacy

Use `<private>` tags to exclude sensitive content from memory storage:

```
<private>database password is xxx</private>
Help me configure the connection
```

Content inside `<private>` tags is replaced with `[REDACTED]` before storage. This applies to prompt saving, observation compression, and session summaries.

## Configuration

Edit `~/.kiro-mem/config.json`, or run `kiro-mem config` for interactive setup:

```json
{
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

**Context Settings:**

| Setting | Default | Description |
| --- | --- | --- |
| `maxObservations` | 50 | Max observations in the index |
| `maxSessions` | 10 | Pull observations from recent N sessions |
| `fullCount` | 5 | Number of observations to expand with full narrative |
| `fullField` | `narrative` | Field to expand (`narrative` or `facts`) |
| `maxOutputBytes` | 8192 | Output size cap (agentSpawn limit is 10KB) |
| `includePinned` | true | Show pinned observations in a top section |
| `includeSummary` | false | Include last session's summary line |

**Supported Providers:**

| Provider    | Configuration                                       | API Key Required |
| ----------- | --------------------------------------------------- | :--------------: |
| `anthropic` | Default                                             |        ✅        |
| `openai`    | Set `provider` + `apiKey`                           |        ✅        |
| `ollama`    | Set `provider` + `baseUrl`                          |        ❌        |
| `custom`    | Any OpenAI-compatible API, set `baseUrl` + `apiKey` |        ✅        |

## Management

```bash
kiro-mem status       # Check Worker status
kiro-mem start        # Start Worker
kiro-mem stop         # Stop Worker
kiro-mem config       # Change compression model config
kiro-mem config --show # View current config
kiro-mem uninstall    # Uninstall (preserves database)
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

| Limitation                   | Impact                                | Mitigation                              |
| ---------------------------- | ------------------------------------- | --------------------------------------- |
| No session ID in hooks       | Cannot precisely map Kiro sessions    | Inferred via cwd + 30min time window    |
| agentSpawn output limit 10KB | Index size is capped                  | Default 50 observations ≈ 2-3KB         |
| AI compression has cost      | Depends on model choice               | Configurable provider, supports Ollama  |
| Chinese FTS < 3 chars        | Short Chinese words use LIKE fallback | Observations include bilingual concepts |
| Local only                   | No cross-machine sync                 | Future: git sync or cloud storage       |

## License

MIT
