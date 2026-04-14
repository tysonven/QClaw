#!/bin/bash
# Charlie Task Watcher
# Polls Supabase for queued tasks and executes them via Claude Code

# Find env file (supports root and flowos user paths)
ENV_FILE=""
if [ -f "/root/.quantumclaw/.env" ]; then ENV_FILE="/root/.quantumclaw/.env"
elif [ -f "$HOME/.quantumclaw/.env" ]; then ENV_FILE="$HOME/.quantumclaw/.env"
elif [ -f "/home/flowos/.quantumclaw/.env" ]; then ENV_FILE="/home/flowos/.quantumclaw/.env"
fi
if [ -z "$ENV_FILE" ]; then echo "ERROR: .quantumclaw/.env not found"; exit 1; fi

ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY "$ENV_FILE" | cut -d= -f2)
SUPABASE_URL=$(grep "^SUPABASE_URL" "$ENV_FILE" | cut -d= -f2)
SUPABASE_ANON_KEY=$(grep "^SUPABASE_ANON_KEY" "$ENV_FILE" | cut -d= -f2)
TG_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN" "$ENV_FILE" | cut -d= -f2)
CHAT_ID=1375806243

send_telegram() {
  curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":$CHAT_ID,\"text\":$(echo "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')}" > /dev/null
}

echo "Task watcher started"

while true; do
  # Check for queued or pending tasks assigned to claude-code
  TASKS=$(curl -s \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    "$SUPABASE_URL/rest/v1/charlie_tasks?status=in.(queued,pending)&assigned_to=eq.claude-code&select=id,title&order=priority.asc,created_at.asc&limit=1")

  TASK_ID=$(echo "$TASKS" | python3 -c 'import sys,json; t=json.load(sys.stdin); print(t[0]["id"]) if t else print("")' 2>/dev/null)

  if [ -n "$TASK_ID" ]; then
    TITLE=$(echo "$TASKS" | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["title"])' 2>/dev/null)
    echo "Running task: $TITLE ($TASK_ID)"

    # Execute the task
    bash /root/QClaw/src/agents/run-task.sh "$TASK_ID" > /tmp/task-output-$TASK_ID.log 2>&1
    EXIT_CODE=$?

    # Send result to Telegram
    if [ $EXIT_CODE -eq 0 ]; then
      OUTPUT=$(tail -20 /tmp/task-output-$TASK_ID.log)
      SUMMARY=$(echo "$OUTPUT" | head -c 3000)
      send_telegram "Task completed: $TITLE

$SUMMARY"

      # Run QA async — doesn't block the watcher
      echo "Triggering QA for task $TASK_ID"
      bash /root/QClaw/src/agents/qa-runner.sh "$TASK_ID" > /tmp/qa-output-$TASK_ID.log 2>&1 &
    else
      OUTPUT=$(tail -20 /tmp/task-output-$TASK_ID.log)
      send_telegram "Task failed: $TITLE

$OUTPUT"
    fi
  fi

  sleep 5
done
