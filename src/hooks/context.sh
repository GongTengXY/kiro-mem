#!/bin/bash
# agentSpawn: 向 Worker 请求历史摘要，STDOUT 注入 AI 上下文
EVENT=$(cat)
CWD=$(echo "$EVENT" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
PORT=$(cat ~/.kiro-memory/.worker.port 2>/dev/null || echo "37778")

CONTEXT=$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/context?cwd=$(printf '%s' "$CWD" | sed 's/ /%20/g')" 2>/dev/null) || exit 0
[ -z "$CONTEXT" ] && exit 0
echo "$CONTEXT"
