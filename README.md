<p align="center">
  <img src="docs/assets/logo.png" alt="kiro-mem logo" width="320" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/v/kiro-mem.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/dm/kiro-mem.svg" alt="npm downloads" /></a>
  <a href="https://github.com/GongTengXY/kiro-mem/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/kiro-mem.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
</p>

<p align="center">
  <a href="docs/i18n/README.zh.md">🇨🇳 简体中文</a> | <a href="README.md">🇬🇧 English</a>
</p>

#### Persistent memory system for [Kiro CLI](https://kiro.dev).

> Kiro CLI only. Not compatible with Kiro IDE.

[Quick Start](#quick-start) • [How It Works](#how-it-works) • [MCP Tools](#mcp-tools) • [Web Viewer](#web-viewer) • [Configuration](#configuration) • [CLI](#cli) • [Limitations](#limitations) • [License](#license)

---

kiro-mem automatically captures each turn (prompt → tool calls → stop) during Kiro sessions and compresses it into a single immutable **Observation** — one per closed turn. It never rewrites history or guesses topics up front. At session start it injects a compact index of prior work in the current workspace; the agent scans that menu, then searches and pulls full details on demand. Organizing relevance happens at **read time**, driven by the agent, not by fragile write-time clustering.

**Key Features**

- 🧠 **Persistent Memory** — Keep project context across sessions
- 🧩 **Atomic & Immutable** — One closed turn → one Observation; text is never rewritten or merged
- 🤖 **ACP-native** — Compression runs through Kiro CLI ACP — no LLM API key required
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic recall, fused with RRF and hard-scoped per workspace; a query with no shared wording can still find the record
- 📊 **Read-time Organization** — Inject a compact index; the agent pulls relevance on demand (`search` → `timeline` → `get_observations`)
- 🔧 **MCP Tools** — `search`, `timeline`, `get_observations`, `pin`
- 🖥 **Web Viewer** — Local browser UI: browse each Observation next to the turn it came from, preview the exact context the next session will receive, and permanently delete a memory together with its source turn
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Persistent job queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for the CLI, the runtime compressor prompt and the Web Viewer UI

## Quick Start

Requires [Bun](https://bun.sh) and a [Kiro CLI](https://kiro.dev) build that supports the `acp` subcommand.

> **V3 is a clean break from V2, and the only supported upgrade path is a full wipe and reinstall.** There is no database migration and no compatibility mode; running a V3 install over V2 data is not supported and is not tested.
>
> ```bash
> kiro-mem stop
> kiro-mem uninstall --purge   # ⚠️ see the warning below
> npm i -g kiro-mem@3
> kiro-mem install
> ```
>
> ### ⚠️ `--purge` permanently deletes all memory and configuration
>
> It removes `~/.kiro-mem` in full: every captured turn, every Observation, every vector, the job queue, your `config.json`, and the local Worker token. **This cannot be undone and there is no export.** If any of that history matters to you, copy `~/.kiro-mem` somewhere else before running it — note that a V2 copy cannot be read back by V3.
>
> `kiro-mem stop` first is not optional: it prevents the old Worker from writing into a directory that is being removed underneath it.

For a first-time installation:

```bash
npm i -g kiro-mem@3
kiro-mem install
```

The installer checks Kiro CLI ACP availability, creates a high-entropy local Worker token with owner-only permissions, copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models/`, lays out the isolated `kiro-runtime` (compressor sub-agent + prompt), then registers and starts the Worker under `launchd`/`systemd`. **No API key required** — memory compression runs through `kiro-cli acp` against your existing Kiro session.

The Worker fails fast on startup if `kiro-runtime` is incomplete (missing agent file, missing prompt, or `tools` accidentally non-empty), so a broken layout never silently degrades compression purity. Re-run `kiro-mem install` to repair.

### Set As Default Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

Or switch inside a chat session:

```text
/agent kiro-mem
```

> **A mid-session switch does not inject the memory index.** `agentSpawn` is a
> session-start trigger — its array-format alias is literally `SessionStart` — and
> Kiro CLI does not replay it when you switch agents. Measured on kiro-cli 2.19.1
> with a probe agent whose `agentSpawn` hook appends to a file: starting with
> `--agent probe` writes one line, while starting on another agent and then running
> `/agent probe` writes none, even though the TUI confirms `Agent changed to probe`.
>
> Everything else about the switched-in agent is live: `/mcp` shows `kiro-mem ●
> running 4 tools` and the `userPromptSubmit` / `postToolUse` / `stop` hooks do
> fire, so the turn is still captured and compressed — you only lose the injected
> index for that session. To get it anyway, either start the session on kiro-mem,
> ask the agent to `@kiro-mem/search` explicitly, or paste the exact string the
> hook would have injected:
>
> ```bash
> curl -s -H "Authorization: Bearer $(cat ~/.kiro-mem/.token)" \
>   "http://127.0.0.1:37778/context/bootstrap?cwd=$PWD"
> ```

### Verify Installation

```bash
kiro-mem diagnose
kiro-mem status
curl http://127.0.0.1:37778/health
```

## How It Works

**Architecture**

1. **Core Truth Layer** — `session_id` → `turns` → `turn_events` (append-only raw hook payloads) + `turn_artifacts` (deterministic extraction: tools, files, commands, test/build/lint signals, errors). This layer is never rewritten and can rebuild any projection.
2. **Synthesis Layer** — Persistent jobs (`summarize_turn` → `embed_observation`) drive an **ACP runtime pool**: each prompt goes to a `kiro-cli acp` sub-process running an isolated `kiro-mem-compressor` sub-agent declared with `tools: []`. Any tool-call notification on that session is treated as contamination and the runtime slot is recycled. `summarize_turn` consumes the user prompt, the assistant's final response (`assistant_response`), and the deterministic artifacts, then writes exactly one immutable Observation per closed turn (idempotent on `turn_id`). It never clusters, merges, or supersedes. On compression failure it degrades to a `quality=fallback` Observation carrying only deterministic evidence — never a fabricated result.
3. **Retrieval Layer** — `observations_fts` (FTS5) and local semantic recall run as two independent legs, fused with RRF and hard-scoped by workspace → MCP tools → context injection. The semantic leg does not need a keyword hit to run: it can recall a record nothing in the query literally matches, bounded by a cosine floor and a semantic-only cap.

At session start, kiro-mem injects a compact **Observation index** for the current workspace: pinned observations, a few recent entries with a short outcome snippet, and a longer recent index where each line carries an approximate read cost. It is a menu, not the content — no LLM synthesis, no topics. The agent then pulls relevance on demand via `search` → `timeline` → `get_observations`.

**Data Model**

- `session_refs` — Session isolation metadata
- `turns` + `turn_events` — Per-turn lifecycle row + append-only raw hook payloads (truth layer)
- `turn_artifacts` — Deterministic extraction (tools, files, commands, test/build/lint signals, errors)
- `observations` — Immutable per-turn memory unit: one closed turn → one Observation, text never rewritten
- `observations_fts` (FTS5 trigram) + `observation_embeddings` — Hybrid search backing tables
- `jobs` — Persistent async task queue

## MCP Tools

| Tool               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `search`           | Hybrid search observations with `type`, `days`, `repo`/`cwd` filters           |
| `timeline`         | Show temporally adjacent observations around one, in real source-turn order    |
| `get_observations` | Fetch full observation details by ID, with source-turn metadata                |
| `pin`              | Mark or unmark an observation for later context                                |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=42 before=3 after=3 mode="scope"
@kiro-mem/get_observations ids=[42,56]
```

`search` is hard-scoped to the current workspace via `computeScopeKey(repo, cwd)` — pass `repo`/`cwd` to target a specific scope, or `all_scopes: true` to browse everything. `timeline` anchors on an observation's **source turn** (not its ID), so neighbors reflect the real work timeline; use `mode="session"` to stay within one conversation instead of the whole workspace.

**Observation Types (`memory_type`):** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Privacy

Use `<private>` tags to redact sensitive content before storage:

```text
<private>database password is xxx</private>
Help me configure the connection
```

Content inside `<private>` tags is replaced with `[REDACTED]` before it is written to storage — this covers the user prompt, tool payloads, and the assistant's final response, so private text never reaches an Observation or the injected index.

## Web Viewer

```bash
kiro-mem viewer
```

Opens a local browser UI served by the Worker itself — no CDN, no dev server, no network beyond loopback. It starts on **All workspaces**; the workspace picker narrows the feed to one project and lists each workspace with its full path, Observation count and last activity. A standing notice remains visible while the global view is selected.

The whole UI renders in **one language, chosen by `config.language`** and delivered in the bootstrap response — no bilingual labels. A `kiro-mem config` change takes effect on the next page load. If the field is absent (an older Worker), it falls back to English.

What it answers:

- **What was remembered** — a live Feed of Observations, newest first, with type, quality, pin state and a summary/outcome snippet. New Observations appear as their compression commits.
- **Whether the memory is faithful** — each card opens a side-by-side detail view: the generated fields (`title`, `summary`, `request`, `outcome`, `learned`, `next_steps`, evidence, concepts, files) next to the Truth Layer they came from (`prompt_text`, deterministic artifacts, event counts and original byte sizes). Raw event payloads load on demand and are bounded per event and per response, so a 4MB turn cannot stall the page.
- **What the next session will receive** — the context preview renders the exact string the `agentSpawn` hook injects, with `usedBytes / effectiveMaxBytes` and a per-section byte breakdown (frame, trust boundary, usage, pinned, recent-detail, recent-index). The budget is adjustable for preview and clamped server-side to 9500 bytes.
- **Why a search matched** — keyword search over the current scope, with `match_source` shown per result. Viewer search is **keyword-only**: it never fabricates a `semantic_query_en` on your behalf, so results labelled `semantic` come from the agent-facing path, not from this UI.
- **Whether retrieval is healthy** — a panel projecting the same trailing-24h `search_24h` counters and retrieval profile that `/health` reports, plus a worker error log drawer.

The Viewer has exactly two write actions, and their confirmation matches their reversibility: **pin** toggles optimistically and reports the result in a transient toast (including a rollback notice if the Worker refuses it), while **delete** always opens a modal stating what will be destroyed.

### Permanent Deletion

The trash icon on a card (or in the detail header) opens a confirmation showing the Observation id and title, the workspace, the turn's start/stop time, and how many raw events and original bytes will be destroyed. Confirming deletes, in **one SQLite transaction**:

the Observation → its vectors and semantic-normalization row → its FTS entry → the source turn's `turn_artifacts`, `turn_events` and `turns` row → every `pending` or terminal job attached to that turn or Observation.

There is deliberately **no** "delete the memory but keep the turn" mode: a kept turn is exactly what `kiro-mem repair` re-queues, so the record would come back. After a successful delete the turn cannot be reached by `search`, `timeline`, `get_observations`, context injection or `repair`, and every open Viewer removes the card immediately.

Refusals are honest rather than partial:

- a related job in `leased` state returns **409** and changes **nothing** — an ACP or CPU task cannot be cancelled mid-flight, so retry after it finishes;
- any SQL failure rolls the whole transaction back, leaving row counts unchanged;
- `pin` does not block deletion; it only affects display and injection priority.

This is product-level permanent deletion — not queryable, not retrievable, not rebuildable. It is **not** a forensic wipe: ordinary SQLite `DELETE` leaves bytes in the WAL, the freelist, filesystem snapshots and any backup you took, and kiro-mem deliberately does not run an automatic `VACUUM` or rewrite the database.

### Security Model

- The Viewer runs on the same loopback-only Worker and reuses the existing local Bearer token. `/ui` and its two static assets are the public shell; **every** `/api/viewer/*` route fails closed without the token.
- `kiro-mem viewer` hands the token over in the URL **fragment**, which browsers never send to the server. The page moves it into that tab's `sessionStorage` and rewrites the URL, so the token stays out of history, Referer headers and the Worker's logs. Closing the tab ends the session; a 401 shows "run `kiro-mem viewer` again" instead of reconnecting in a loop.
- Requests must carry an exact loopback `Host` matching the Worker's port, which blocks DNS rebinding. `DELETE` additionally requires an `Origin` identical to the page's own origin.
- Responses set `nosniff`, `DENY` framing, `no-referrer`, same-origin COOP/CORP and a CSP of `default-src 'none'` with only `'self'` scripts and styles.
- Recorded memory is untrusted input and is rendered as text nodes only. There is no `dangerouslySetInnerHTML`, no Markdown rendering and no auto-linking anywhere in the bundle.

If the Viewer bundle is missing (a source checkout that has not run `bun run build:ui`), the Worker still starts normally and `/ui` returns a readable build hint.

## Configuration

Edit `~/.kiro-mem/config.json`, or run `kiro-mem config` for interactive setup:

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

- `language`: `zh` or `en`. Drives the CLI output, the runtime compressor prompt **and** the Web Viewer UI, which renders in this language only.
- `compression.concurrency`: number of parallel `kiro-cli acp` runtime processes (default `3`).
- `compression.timeoutMs`: per-prompt timeout in milliseconds, clamped to `[5000, 60000]` when set via `kiro-mem config` (default `30000`).
- `compression.maxRetries`: how many JSON-repair retries to attempt before degrading to a `quality=fallback` Observation (default `2`).
- `runtime.kiroHome`: isolated `KIRO_HOME` for the compressor sub-agent. Empty falls back to `<dataDir>/kiro-runtime`, which is the layout `kiro-mem install` lays down.
- `context.maxOutputBytes`: byte budget for the injected Observation index, kept below the `agentSpawn` 10KB limit (default `8192`).
- `retrieval.semanticDiscovery`: whether semantic similarity may surface records that keyword search never matched (default `true`). See below.

### Semantic Discovery and Rollback

`retrieval.semanticDiscovery: true` is the current code default: a `search` that carries a legal `semantic_query_en` runs the semantic leg even when FTS matched nothing in this workspace, so a question phrased entirely differently from the record can still find it. This profile **has not passed the final P6 false-recall gate** (C1 measured **1.900** against a `≤ 1` bar). Shipping it on by default is a **recorded, informed decision** — `benchmark/reports/release-decision-2026-08-14.md` — not a passed gate: turning it off does not mean "two fewer results", it means **a search returns nothing at all when no keyword matched**, and the blind audit measured that capability as old-record hit@5 going from 0% to 80.77%. The gate reading itself is unchanged, and so is every cost listed in [Limitations](#limitations). A later round scanned floor 0.197–0.325 × cap 1–2 on an independent calibration set and found **no safe working point at all** — see "No cosine threshold separates the two sides" in [Limitations](#limitations) for the readings and, importantly, for which datasets they came from and why neither can be used to pick a threshold. Treat `0.197` as the calibrated default, not as a knob a higher value would make safer. Its current bounds, selected by an earlier full-pipeline parameter scan, are a cosine floor of `0.197` and **at most 2 semantic-only results per search**. Results that only the semantic leg found are labelled `match_source: "semantic"` and should be verified before you act on them.

The cap bounds one source label, not the whole page: `fts` and `hybrid` results were never subject to it, and once the default time window became unbounded the keyword leg's reach grew with it. Treat the cap as a quota on unverified pure-semantic leads, not as complete page safety.

Setting it to `false` is the rollback. For queries that carry a legal `semantic_query_en` it restores the previous behavior — keyword anchor required, floor `0.2`, no semantic-only cap, recency tie-break — and takes effect for Kiro sessions started after the edit.

One thing the rollback deliberately does **not** restore: a search with a missing or refused `semantic_query_en` stays keyword-only under either setting. The old build scored the `raw-v1` space in that case, and that space has no defensible threshold, so a single keyword hit was enough to put an unrelated record on the page labelled `semantic`. That is a fixed safety hole, not a rollback gap.

```bash
# roll back
kiro-mem config --show   # shows the active profile
# edit ~/.kiro-mem/config.json: "retrieval": { "semanticDiscovery": false }
```

The switch changes retrieval only. It does not touch the database schema, the stored vectors or the embedding protocol, so it can be flipped back and forth with no rebuild and no data loss.

### Retrieval Metrics

`curl http://127.0.0.1:37778/health` and `kiro-mem diagnose` report a trailing 24h window of search counters. They hold counts, enum reasons and latency only — never query text, Observation text or workspace paths.

| Field (`search_24h`) | Meaning |
| --- | --- |
| `requests` / `latencyMsP50` / `latencyMsP95` | Search volume and latency. |
| `protocolSemanticEn` / `semanticEnRate` | How many searches actually ran in the English vector space. Independent semantic recall only works there, so a low rate means the feature is shipped but mostly unreachable. |
| `semanticQueryIssues` | Why the English form was unusable, by reason: `missing` (the agent never passed `semantic_query_en`) plus guardrail rejections such as `untranslated` or `placeholder`. |
| `ftsOnly` / `degradeRate` | Searches that fell back to keyword-only because the query embedding was unavailable (Worker down, timeout). A degraded request is a capability failure, not a policy choice. |
| `zeroFts` / `zeroFtsRecalled` | Searches with no keyword match at all, and how many of those still returned something via semantic recall. This is the number the feature exists to move. |
| `semanticOnlyTotal` / `semanticOnlyPerRequest` / `semanticOnlyMax` | Volume of unverified semantic-only leads. `semanticOnlyMax` must never exceed the cap. |
| `comparableVectors` (avg) | How many stored vectors the semantic leg scored. The candidate pool is scope-wide, so this tracks how much of the workspace a search actually compared against rather than saturating at a constant. |
| `scopeVectors` (avg / min / measured) | Vectors in the active space across the WHOLE searched scope — not the candidate pool. This is the number that answers "has this workspace been embedded under this protocol?". `null` (not counted) when the semantic step never ran, which is deliberately different from 0. |
| `emptyScopeRequests` | Searches whose scope had no vectors at all. Non-zero means semantic recall was structurally impossible for them — a rebuild or job-backlog problem, not a relevance one. |

`/health` also reports the active profile under `retrieval`, read from disk on every call, so "did my rollback take effect?" is answerable without reading code. It reports what the **next** session will serve — a session already running keeps the profile it started with.

## CLI

```bash
kiro-mem install
kiro-mem status
kiro-mem start
kiro-mem stop
kiro-mem config
kiro-mem config --show
kiro-mem diagnose
kiro-mem repair
kiro-mem viewer
kiro-mem uninstall
kiro-mem uninstall --purge
```

## System Requirements

- **Bun**: Latest version
- **Kiro CLI**: **>= 2.3.0** — earlier versions lack the `acp` subcommand and the `KIRO_HOME` override that the isolated compressor sub-agent depends on. Run `kiro-cli --version` and `kiro-cli acp --help` to verify.
- **macOS / Linux**: Required for Worker keepalive via `launchd` / `systemd`

## Limitations

| Limitation                          | Impact                                                                | Mitigation                                    |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Capture is best-effort              | Hooks give the Worker ~700ms and never block your turn, so a Worker restart or transient error can drop a raw event. Dropped input cannot be reconstructed later — memory is not guaranteed to be complete | Misses are counted per hook and reason; see `capture_misses_24h` in `/health` and the warning line in `kiro-mem diagnose` |
| Deletion is one record at a time, and manual | Nothing expires on its own: there is no retention policy, no automatic cleanup and no batch `prune`, because kiro-mem does not decide which of your memories are worthless. The Web Viewer deletes **one** Observation together with its source turn per confirmation, and there is no export, no bulk delete, no soft delete and no undo. A `leased` related job makes that one deletion return 409 until it finishes | Delete from the Viewer for anything you want gone; `<private>` tags keep sensitive content out of storage in the first place; `kiro-mem uninstall --purge` still wipes everything at once |
| Deletion is not a forensic wipe    | Ordinary SQLite `DELETE` leaves the old bytes reachable in the WAL, the freelist, filesystem snapshots and any backup you already took. kiro-mem deliberately runs no automatic `VACUUM` and never rewrites the database, so "permanently deleted" means unreachable to every kiro-mem read path — not scrubbed from the disk | Treat the promise as product-level: not queryable, not retrievable, not rebuildable. For media-level guarantees use full-disk encryption and control your own backups |
| Raw event payloads are capped        | A tool response over 32KB per string field is truncated, and a single turn stores at most 4MB of raw payload. Truncation is marked inline, but the dropped bytes are not recoverable | `payload_size` still records the original size; artifacts extraction keeps working on the capped payload |
| Requires Kiro CLI ACP               | Compression cannot run without a working `kiro-cli acp` subcommand    | `kiro-mem diagnose` runs an ACP smoke test    |
| `agentSpawn` output limit 10KB      | Injected index must stay compact                                      | Budget-controlled context builder             |
| Mid-session `/agent` switch injects nothing | `agentSpawn` is a session-start trigger, so switching into kiro-mem with `/agent` leaves that session without the memory index. Capture and the MCP tools do keep working — only the injected menu is missing | Start the session on kiro-mem (`--agent kiro-mem` or `chat.defaultAgent`), ask for `@kiro-mem/search` explicitly, or paste `/context/bootstrap` output — see [Set As Default Agent](#set-as-default-agent) |
| Search queries shorter than 3 chars | Falls back to `LIKE`, less precise                                    | Use longer terms when possible                |
| Search has no default time limit, and no retention policy | `search` defaults to the whole history, so the searchable range equals what the injected index can show — a record from two years ago is reachable. The cost is that the semantic leg's working set grows with the corpus and nothing ever expires. Measured ceiling: 50,000 records spread over 3 years, p95 203–260ms and search-loop memory +264…+294MB across three runs. Beyond that size the behavior is unmeasured | Pass `days=N` to narrow one search. `retrieval.semanticDiscovery: false` restores the previous profile, which also restores its 200-record pool |
| Semantic-only results are unverified | A query with no keyword overlap can now find records through meaning alone, but those results rest on vector similarity only, and a query about work this project never did can still return up to 2 plausible-looking records. An independent blind audit measured a mean of 1.9 returned records across 30 hard negatives — the cap is reached on nearly every one of them | They are labelled `match_source: "semantic"` and capped at 2 per search; verify with `get_observations` or the current code before acting. The cap covers only the `semantic` label — `fts` and `hybrid` results are not bounded by it |
| No cosine threshold separates the two sides | Two measurements, on two datasets that are **both already consumed** — neither is a new independent validation set. **P3 set** (40 records / 131 queries; independent of the earlier blind-audit set, but consumed by P3's own floor × cap selection): the best-scoring false lead reached cosine **0.604** while the best-scoring true answer reached **0.602** — the false lead outscored the real one. So no single absolute cosine floor can both zero the 17 zero-FTS foreign-domain negatives and keep every `primary_gold` semantically reachable; a floor above 0.604 costs all 61 of them that reachability. **P4.0 probe** (a different, also-consumed set: 26 relevance + 30 hard-negative queries): relative normalization measured **worse** than the raw score — z-score AUC **0.735** vs raw top-1 AUC **0.841** — because a query about work that never happened has a lower corpus background, so normalization rewards it | **Read the boundaries with the numbers.** Both sets are consumed: they are descriptive evidence only, and no threshold may be selected on either. The P3 reading is measured on zero-FTS queries only and does **not** apply to lexical-anchor queries, whose pages the FTS leg fills; its negative side is a page-max score while its positive side is a query→own-gold cosine, comparable only as "the highest similarity this query can reach in this space". Losing semantic reachability is **not** losing the answer — the FTS leg can still return it, and full-page recall held at primary hit@5 **67.2%** across floors 0.197–0.300. Neither reading overrides the 1.9 above, which comes from the blind audit. Annotator and author were the same person |
| Lexical admission was tried and does not close the gap | The FTS leg admits a record on a single 3-character window match, and a round dedicated to fixing exactly that **did not pass**: 16 arms (window-coverage ratio × unit df ceiling) on a 60,066-row Chinese-competition fixture moved per-page `distinctContent` on 40 lexical hard negatives from 38/40 over the cap down to 9/40, never to the cap of 2. The 9 that survive all carry anchors that genuinely exist in the corpus, so their window coverage is satisfied by construction. Tightening further spent positives instead: primary hit@5 0.813 → 0.713 and `primary_gold` absent from the page 11 → 19 of 80 | Full readings in `benchmark/reports/fts-round/f4-completion.md`; the mechanical verdict is `no-safe-arm` (`f4-selection.json`). **Production behavior is unchanged** — the admission variables never shipped, they existed only in a benchmark injection seam. Content-level evidence, not lexical counting, is the registered next direction |
| Semantic search needs the English form | The semantic leg runs ONLY in the `semantic-en-v1` space. If the agent omits `semantic_query_en` or the guardrail refuses it, the search is **keyword-only**: no query vector is computed and no stored vector is read, so that request loses semantic reranking as well as semantic recall. The `raw-v1` space is never scored, because it has no usable relevance threshold — annotated matches and pure noise overlap in it | `semanticEnRate` and `semanticQueryIssues` (including `missing`) in `/health` / `kiro-mem diagnose` show how often that happens |
| Only the top 1,000 semantic candidates keep a rank | The candidate pool is scope-wide — every vector in the searched scope gets scored, and by default no time window narrows that, so no record is invisible to the semantic leg because of its age. What is bounded is retention: candidates are read in chunks, scored immediately, and only the best 1,000 keep a rank (plus every keyword hit, at any score). Returned pages were identical to full scoring on every measured corpus, including at 50,000 records where only 163 of 4,618 above-floor candidates survived — a rank in the thousands cannot reach a page of 10. What does change is observability: a record outside the top 1,000 has no recorded semantic rank | Measured at 50,000 records: full-search p95 158–286ms against a 300ms budget, search-loop memory +225…+324MB against 512MB |
| Install step                        | Copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models` | Model ships in the package — no model download |
| Viewer search is keyword-only        | The Viewer never fabricates a `semantic_query_en`, so its search runs the FTS leg alone: a question phrased entirely differently from the record will not find it here, even though the agent's own `search` could | Use `@kiro-mem/search` from a Kiro session for semantic recall; the Viewer labels every result with its `match_source` so the difference is visible |
| Viewer is loopback-only, single user | It is served by the local Worker on 127.0.0.1 and authenticated by the same local token, handed over in the URL fragment. There is no multi-user model, no remote access and no session beyond the browser tab you opened | Run `kiro-mem viewer` on the machine that holds the data; a closed tab ends the session |
| Local only                          | No built-in cross-machine sync                                        | Future: git sync or cloud storage             |

## License

MIT
