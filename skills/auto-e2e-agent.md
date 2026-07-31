SKILL: auto-e2e-agent
NAME: Claude Agent Auto E2E Runner
VERSION: 2.0

REQUIRED FILES (follow it):
- /home/ubuntu/codeatlas-platform/.claude/task-e2e.md (user's request: agent tự chủ, không hỏi permission, đóng vai developer cho CodeAtlas Second Brain)
- /home/ubuntu/codeatlas-platform/.claude/task.md (chiêu ép AI chạy bằng sạch: vòng lặp vĩnh cửu, cấm tự mãn, kill zombie, definition of done = exit code 0)
- /home/ubuntu/codeatlas-platform/auto-e2e.sh (script chạy trên sandbox VPS)

CONFIG:
- SSH: sshpass -p '123456' ssh -F ~/.ssh/sandbox_config sandbox-tunnel
- Claude CLI: /usr/bin/claude (đã cài)
- 9router tunnel: https://9router.clientfindemail.site/v1
- Auth token: sk-258bda03c2d94b68-ctj6bi-24b92217 (hoạt động - test OK 200)
- Model: model-medium-hight

AGENT BEHAVIOR (required follow):
1. Auto-attach system: kill zombie (chrome, node) trước mỗi lần chạy
2. Chạy pnpm install + pnpm test trên /root/codeatlas-platform
3. Nếu exit code != 0: gọi Claude agent (`claude --dangerously-skip-permissions`) với prompt cứng:
   - Mục tiêu duy nhất: pnpm test exit 0
   - Không dừng khi lỗi, rollback và thử B/C
   - Định nghĩa xong: chỉ khi exit code thực sự 0
   - Tự dọn dẹp zombie trước mỗi lần sửa
   - Đóng vai AI Developer cho CodeAtlas Second Brain (tự quyết định sửa source code)
4. Vòng lặp tối đa 50 lần (tẹt ga token)
5. Log: /tmp/agent-run.log, /tmp/e2e_test.log, /tmp/claude_agent.log

USE IN SANDBOX:
  sshpass -p '123456' ssh -F /home/ubuntu/.ssh/sandbox_config sandbox-tunnel 'nohup /root/codeatlas-platform/auto-e2e.sh > /tmp/agent-run.log 2>&1 < /dev/null &'

VERIFY:
- Claude -p "hi" trả về đúng
- Auth 200 OK với token mới
- Agent đang chạy (Lượt 1/50) và log cập nhật
