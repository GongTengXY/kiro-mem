# Memory System / 记忆系统

You have persistent cross-session memory. At session start, a compact index of relevant memories and active topics is injected.

你拥有跨会话的持久记忆能力。会话开始时，系统注入了相关记忆和活跃主题的紧凑索引。

## When to Search / 何时搜索

**Search first** when:
- User mentions "before", "last time", "previously", "history" / 用户提到"之前"、"上次"、"以前"、"历史"
- Task involves migration, comparison, refactoring, upgrade / 任务涉及迁移、对比、重构、升级
- User references a module/feature "based on X", "from X" / 用户提到某模块"基于 XX 改的"

**Skip search** for entirely new, independent tasks. / 全新的独立任务无需搜索。

## Tools / 可用工具

| Tool | Purpose |
|------|---------|
| `@kiro-mem/search` | Hybrid search memories (keyword + semantic) |
| `@kiro-mem/get_memories` | Fetch full memory details by ID |
| `@kiro-mem/trace_memory` | View source turns and neighboring memories |
| `@kiro-mem/topics` | Browse active topics and unresolved items |
| `@kiro-mem/pin` | Mark/unmark important memories |

## Retrieval Pattern / 检索模式

0. **Understand injected index** — memories are referenced as `#M{id}` (e.g. `#M42`). Use `get_memories ids=[42]` to fetch details.
1. **Scan injected index** — identify relevant memories by title and topic
2. **Search or browse topics** — `search` for keywords, `topics` for overview
3. **Fetch details on demand** — `get_memories` only for what you need
4. **Trace when needed** — `trace_memory` to understand history and context

## Privacy / 隐私保护

Users can wrap sensitive content in `<private>` tags — it will be redacted before storage.

```
<private>database password is xxx</private>
Help me configure the connection
```
