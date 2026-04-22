#!/bin/bash
# userPromptSubmit: 保存用户 prompt 到 Worker
EVENT=$(cat)
PORT=$(cat ~/.kiro-mem/.worker.port 2>/dev/null || echo "37778")

curl -s --max-time 2 -X POST "http://127.0.0.1:${PORT}/events/prompt" \
  -H "Content-Type: application/json" -d "$EVENT" >/dev/null 2>&1 || true
exit 0
