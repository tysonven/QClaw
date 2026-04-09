#!/bin/bash
# Charlie QA Runner
# Usage: ./qa-runner.sh <task_id>
# Reviews a completed task and updates qa_status

set -e

TASK_ID=$1
if [ -z "$TASK_ID" ]; then
  echo "Usage: $0 <task_id>"
  exit 1
fi

# Load env vars (same pattern as task-watcher.sh)
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /root/.quantumclaw/.env | cut -d= -f2)
SUPABASE_URL=$(grep "^SUPABASE_URL" /root/.quantumclaw/.env | cut -d= -f2)
SUPABASE_ANON_KEY=$(grep "^SUPABASE_ANON_KEY" /root/.quantumclaw/.env | cut -d= -f2)
TG_TOKEN="8588434821:AAHFS3CUfnf7VTY3c1LYH7iKhUhq3cXIg0g"
CHAT_ID=1375806243

# Fetch completed task from Supabase
TASK=$(curl -s \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID&select=*" \
  | python3 -c "import sys,json; t=json.load(sys.stdin); print(json.dumps(t[0])) if t else sys.exit(1)")

TITLE=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])")
INSTRUCTIONS=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('instructions',''))")
RESULT=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))")
TASK_TYPE=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type','build'))")

echo "QA reviewing task: $TITLE"

# Build QA prompt
read -r -d '' QA_PROMPT << 'QAPROMPT' || true
You are a QA agent reviewing a completed task.

Task title: PLACEHOLDER_TITLE
Task type: PLACEHOLDER_TYPE
Original instructions:
PLACEHOLDER_INSTRUCTIONS

Result produced:
PLACEHOLDER_RESULT

Review this task against the following QA checklist:

1. COMPLETENESS: Did the result address all points in the instructions?
2. SECURITY: Were any credentials hardcoded? Were secrets handled correctly?
3. CORRECTNESS: Does the result make logical sense for the task type?
4. COMMIT: Was the work committed to git if it was a code change?
5. TESTING: Was the work verified/tested before completion?

For build/infrastructure tasks also check:
- PM2 processes restarted if needed
- New workflows activated in n8n
- Supabase tables have RLS if applicable

Respond with a JSON object only, no other text:
{
  "passed": true or false,
  "score": 1-10,
  "summary": "One sentence summary",
  "issues": ["list of issues found, empty if none"],
  "recommendations": ["list of recommendations, empty if none"]
}
QAPROMPT

# Substitute actual values into prompt
QA_PROMPT="${QA_PROMPT//PLACEHOLDER_TITLE/$TITLE}"
QA_PROMPT="${QA_PROMPT//PLACEHOLDER_TYPE/$TASK_TYPE}"
QA_PROMPT="${QA_PROMPT//PLACEHOLDER_INSTRUCTIONS/$INSTRUCTIONS}"
QA_PROMPT="${QA_PROMPT//PLACEHOLDER_RESULT/$RESULT}"

# Run QA via Claude Code
QA_RESULT=$(sudo -u flowos env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" HOME=/home/flowos \
  claude --print --dangerously-skip-permissions -p "$QA_PROMPT" < /dev/null 2>&1)
EXIT_CODE=$?

# Parse result
PASSED=$(echo "$QA_RESULT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
match = re.search(r'\{.*\}', text, re.DOTALL)
if match:
    d = json.loads(match.group())
    print('true' if d.get('passed') else 'false')
else:
    print('false')
" 2>/dev/null || echo "false")

QA_STATUS="passed"
if [ "$PASSED" != "true" ]; then
  QA_STATUS="failed"
fi

# Update task qa_status and qa_result
QA_RESULT_JSON=$(echo "$QA_RESULT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
curl -s -X PATCH \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"qa_status\":\"$QA_STATUS\",\"qa_result\":$QA_RESULT_JSON,\"qa_completed_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
  "$SUPABASE_URL/rest/v1/charlie_tasks?id=eq.$TASK_ID" > /dev/null

# Send Telegram notification
if [ "$QA_STATUS" = "passed" ]; then
  EMOJI="✅"
else
  EMOJI="⚠️"
fi

SUMMARY=$(echo "$QA_RESULT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
match = re.search(r'\{.*\}', text, re.DOTALL)
if match:
    d = json.loads(match.group())
    print(d.get('summary', 'QA complete'))
else:
    print('QA complete')
" 2>/dev/null || echo "QA complete")

TG_TEXT=$(python3 -c "
import json
print(json.dumps('$EMOJI QA $QA_STATUS: $TITLE\n\n$SUMMARY'))
" 2>/dev/null)

curl -s -X POST \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": $CHAT_ID, \"text\": $TG_TEXT}" > /dev/null

echo "QA $QA_STATUS for task $TASK_ID"
