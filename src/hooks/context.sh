#!/bin/bash
# agentSpawn: 向 Worker 请求历史摘要，STDOUT 注入 AI 上下文
# 如果 Worker 没跑，尝试通过系统服务拉起
EVENT=$(cat)
CWD=$(echo "$EVENT" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
PORT=$(cat ~/.kiro-mem/.worker.port 2>/dev/null || echo "37778")

CONTEXT=$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/context?cwd=$(printf '%s' "$CWD" | sed 's/ /%20/g')" 2>/dev/null)

# If curl failed, try to restart Worker and retry once
if [ $? -ne 0 ] || [ -z "$CONTEXT" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.kiro-mem.worker.plist"
    [ -f "$PLIST" ] && launchctl load "$PLIST" 2>/dev/null
  else
    systemctl --user start kiro-mem.service 2>/dev/null
  fi
  sleep 1
  CONTEXT=$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/context?cwd=$(printf '%s' "$CWD" | sed 's/ /%20/g')" 2>/dev/null) || exit 0
fi

[ -z "$CONTEXT" ] && exit 0
echo "$CONTEXT"
