#!/bin/bash
# Charlie Task Runner
# Usage: ./run-task.sh <task_id>
# Fetches task from Supabase, runs via Claude Code, updates result

TASK_ID=$1
if [ -z "$TASK_ID" ]; then
  echo "Usage: $0 <task_id>"
  exit 1
fi

# Load only the vars we need
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /root/.quantumclaw/.env | cut -d= -f2)
SUPABASE_URL=$(grep "^SUPABASE_URL" /root/.quantumclaw/.env | cut -d= -f2)
SUPABASE_ANON_KEY=$(grep "^SUPABASE_ANON_KEY" /root/.quantumclaw/.env | cut -d= -f2)

# Fetch task from Supabase
TASK=$(curl -s \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID&select=*" \
  | python3 -c "import sys,json; t=json.load(sys.stdin); print(json.dumps(t[0])) if t else sys.exit(1)")

if [ $? -ne 0 ]; then
  echo "Task not found: $TASK_ID"
  exit 1
fi

TITLE=$(echo "$TASK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["title"])')
INSTRUCTIONS=$(echo "$TASK" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("instructions","No instructions provided"))')

echo "Running task: $TITLE"

# Mark in_progress
curl -s -X PATCH \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"in_progress\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
  "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID" > /dev/null

# Run via Claude Code as flowos user (not root) with permissions bypassed
RESULT=$(sudo -u flowos env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" HOME=/home/flowos \
  claude --print --dangerously-skip-permissions -p "$INSTRUCTIONS" < /dev/null 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  STATUS="completed"
  RESULT_JSON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
  curl -s -X PATCH \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"completed\",\"result\":$RESULT_JSON,\"completed_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID" > /dev/null
else
  STATUS="failed"
  ERROR_JSON=$(echo "$RESULT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
  curl -s -X PATCH \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"failed\",\"error_message\":$ERROR_JSON,\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID" > /dev/null
fi

echo "Task $TASK_ID: $STATUS"
echo "$RESULT"
