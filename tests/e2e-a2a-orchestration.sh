#!/bin/bash
set -euo pipefail

KEY="ca_7d94a7d627324b79870c77e3307190ce"
URL="http://localhost:8080/a2a/jsonrpc"

# Helper to make A2A call and extract task object
a2a_call() {
  local payload="$1"
  local response
  response=$(curl -sf -m 10 -H "x-api-key: $KEY" -H "Content-Type: application/json" \
    -d "$payload" "$URL")

  # Parse double-nested artifact text
  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d['result']['artifacts'][0]['parts'][0]['text']
inner = json.loads(text)['content'][0]
obj = json.loads(inner['text'])
print(json.dumps(obj))
"
}

echo "=== STEP 1: Create task (Leader=Admin) ==="
TASK=$(a2a_call '{"jsonrpc":"2.0","method":"tasks/send","params":{"message":{"messageId":"e2e-1","role":"user","parts":[{"kind":"text","text":"{\"tool\":\"a2a_create_orchestration_task\",\"params\":{\"description\":\"E2E test: review PR 77 graph traversal optimization\",\"developer_agent_id\":\"admin\",\"tool_name\":\"review_pr\",\"tool_params\":{\"repo\":\"giauphan/codeatlas-mcp-server\",\"pr\":77}}}"}],"kind":"message"},"taskId":"e2e-create"},"id":1}')

TASK_ID=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['orchestrationTaskId'])")
STATE=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
echo "Task ID: $TASK_ID"
echo "State: $STATE"

echo ""
echo "=== STEP 2: Implement task (Developer=Admin) ==="
TASK=$(a2a_call "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/send\",\"params\":{\"message\":{\"messageId\":\"e2e-2\",\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"{\\\"tool\\\":\\\"a2a_implement_orchestration_task\\\",\\\"params\\\":{\\\"orchestration_task_id\\\":\\\"$TASK_ID\\\",\\\"implementation_artifacts\\\":[{\\\"name\\\":\\\"review-77.md\\\",\\\"parts\\\":[{\\\"kind\\\":\\\"text\\\",\\\"text\\\":\\\"PR 77: Clean optimization. 78pct latency reduction. LGTM.\\\"}]}]}}\"}],\"kind\":\"message\"},\"taskId\":\"e2e-impl\"},\"id\":1}")

STATE=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
echo "State: $STATE"

echo ""
echo "=== STEP 3: Review and approve (Leader=Admin) ==="
TASK=$(a2a_call "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/send\",\"params\":{\"message\":{\"messageId\":\"e2e-3\",\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"{\\\"tool\\\":\\\"a2a_review_orchestration_task\\\",\\\"params\\\":{\\\"orchestration_task_id\\\":\\\"$TASK_ID\\\",\\\"approved\\\":true}}\"}],\"kind\":\"message\"},\"taskId\":\"e2e-review\"},\"id\":1}")

STATE=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
echo "State: $STATE"

echo ""
echo "=== STEP 4: Get final status ==="
TASK=$(a2a_call "{\"jsonrpc\":\"2.0\",\"method\":\"tasks/send\",\"params\":{\"message\":{\"messageId\":\"e2e-4\",\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"{\\\"tool\\\":\\\"a2a_get_orchestration_task\\\",\\\"params\\\":{\\\"orchestration_task_id\\\":\\\"$TASK_ID\\\"}}\"}],\"kind\":\"message\"},\"taskId\":\"e2e-get\"},\"id\":1}")

echo "$TASK" | python3 -c "
import sys, json
t = json.load(sys.stdin)
print(f'Final State: {t[\"state\"]}')
print(f'History: {[(h[\"state\"], h[\"timestamp\"]) for h in t[\"stateHistory\"]]}')
print(f'Leader: {t[\"leaderAgentId\"]}')
print(f'Developer: {t[\"developerAgentId\"]}')
if t['state'] == 'approved':
    print('E2E A2A FLOW COMPLETE: created -> assigned -> implemented -> approved')
else:
    print('Flow incomplete')
"
