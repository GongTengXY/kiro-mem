#!/bin/bash
# stop: 触发会话摘要生成
EVENT=$(cat)
PORT=$(cat ~/.kiro-mem/.worker.port 2>/dev/null || echo "37778")

curl -s --max-time 2 -X POST "http://127.0.0.1:${PORT}/events/stop" \
  -H "Content-Type: application/json" -d "$EVENT" >/dev/null 2>&1 || true
exit 0
