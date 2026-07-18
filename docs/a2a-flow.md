# A2A Flow Diagram

## 1. Agent Discovery Flow

```mermaid
sequenceDiagram
    participant Claude as Claude AI (Client)
    participant A2A_MCP as mcpTools (a2a_discover_agents)
    participant Registry as A2ARegistry
    participant MemStore as memoryStore (tenant-isolated)
    participant Oracle as Oracle 26ai

    Claude->>A2A_MCP: a2a_discover_agents({capability, status})
    A2A_MCP->>Registry: query(filter)
    Registry->>MemStore: scan agents
    alt tenantId filter
        MemStore-->>Registry: agents WHERE tenantId = requestorTenantId
    else Oracle enabled
        Registry->>Oracle: SELECT * FROM agent_registry WHERE tenant_id = :tid
        Oracle-->>Registry: tenant-scoped results
    end
    Registry-->>A2A_MCP: A2AAgentRecord[]
    A2A_MCP-->>Claude: A2AAgentInfo[] (name, url, capabilities)
```

## 2. Agent Card (/.well-known/agent-card.json)

```mermaid
sequenceDiagram
    participant Client as A2A Client
    participant Auth as authMiddleware
    participant Routes as a2aRoutes.ts
    participant CardFactory as agentCard.ts
    participant ToolRegistry as toolRegistry

    Client->>Routes: GET /.well-known/agent-card.json
    alt No auth header
        Auth-->>Client: 401 Unauthorized
    else Valid API key
        Auth->>Auth: authStorage.run(auth, next)
        Auth->>Routes: next()
        Routes->>CardFactory: buildAgentCard(baseUrl)
        CardFactory->>ToolRegistry: toolRegistry.map(t => skill)
        ToolRegistry-->>CardFactory: AgentSkill[]
        CardFactory-->>Routes: AgentCard (28 skills, auth schemes)
        Routes-->>Client: JSON response
    end
```

## 3. A2A JSON-RPC (a2a/jsonrpc)

```mermaid
sequenceDiagram
    participant Client as A2A Client
    participant Auth as authMiddleware
    participant Routes as a2aRoutes.ts
    participant Executor as A2AExecutor
    participant Tool as MCP Tool Handler
    participant DB as Oracle DB

    Client->>Routes: POST /a2a/jsonrpc
    Auth->>Auth: verify x-api-key / Bearer token
    Auth->>Routes: req.auth = {uid, tenantId}

    Routes->>Executor: handleJsonRpc({method, params})

    alt method = "tasks/send"
        Executor->>Executor: parseRequest(text) -> {toolName, params}
        Executor->>Tool: callTool(toolName, params)
        Tool->>DB: SELECT/INSERT with tenant_id filter
        DB-->>Tool: tenant-scoped results
        Tool-->>Executor: result
        Executor-->>Routes: {state: "completed", artifacts}
    else method = "tasks/get"
        Executor->>Executor: tasks.get(taskId)
        Executor-->>Routes: task or error
    else method = "tools/list"
        Executor->>Executor: toolHandlers.keys()
        Executor-->>Routes: {tools: [...]}
    end

    Routes-->>Client: JSON-RPC Response
```

## 4. Task Delegation (Internal A2A Call)

```mermaid
sequenceDiagram
    participant User as User A (tenant=user_a)
    participant A2A_MCP as a2a_delegate_task
    participant ClientSvc as A2AClientService
    participant Cache as agentCache (tenant-isolated)
    participant Remote as Remote A2A Agent

    User->>A2A_MCP: a2a_delegate_task(agentUrl, toolName, params)
    A2A_MCP->>ClientSvc: sendTask(agentUrl, toolName, params)
    ClientSvc->>ClientSvc: authStorage.getStore() -> {uid, keyId}
    ClientSvc->>Cache: getTenantCache().set(url, agentCard)
    ClientSvc->>Remote: jsonRpcCall(url, tasks/send)
    Note over ClientSvc: Headers: x-api-key (from current auth context)
    Remote-->>ClientSvc: task result
    ClientSvc-->>A2A_MCP: result
    A2A_MCP-->>User: task artifact
```

## 5. Context Sharing (a2a_broadcast_context)

```mermaid
sequenceDiagram
    participant Agent as A2A Agent
    participant ClientSvc as A2AClientService
    participant DreamSvc as OracleDreamingService
    participant DB as Oracle DB (ai_dreaming_memory)

    Agent->>ClientSvc: shareContext(project, key, value, visibility)
    ClientSvc->>DreamSvc: saveDreamMemory(project, uuid, "A2A_SHARED_CONTEXT", data, 5)
    DreamSvc->>DreamSvc: authStorage.getStore() -> tenantId
    DreamSvc->>DB: INSERT INTO ai_dreaming_memory (tenant_id, project, content, ...)
    DB-->>DreamSvc: done (tenant-scoped)
    DreamSvc-->>ClientSvc: memoryId
    ClientSvc-->>Agent: context shared
```

## 6. Multi-Tenant Architecture

```mermaid
graph TD
    subgraph "Client Layer"
        A1[User A - tenant=user_a]
        A2[User B - tenant=user_b]
    end

    subgraph "Auth Layer"
        AM[authMiddleware]
        AS[authStorage &lt;AsyncLocalStorage&gt;]
    end

    subgraph "A2A Layer"
        AR[a2aRoutes.ts - authMiddleware]
        AE[A2AExecutor]
        ACS[A2AClientService - agentCache per tenant]
    end

    subgraph "Data Layer"
        REG[A2ARegistry - tenantId filter]
        MEMORY[OracleDreamingService - tenant_id column]
        MCP[MCP Tools - tenant_id in SQL]
    end

    A1 --> AM
    A2 --> AM
    AM --> AS
    AS --> AR
    AS --> ACS
    AS --> MCP
    AR --> AE
    AE --> MCP
    AE --> REG
    ACS --> REG
    MCP --> MEMORY
    REG --> MEMORY
```

## 7. Model Routing (task-router.sh)

```mermaid
flowchart TD
    Start[CLAUDE_TASK_NAME / TYPE] --> Check{Keyword Match?}
    Check -->|"design|architecture|bug fix|debug"| High[Opus-4 + max effort]
    Check -->|"implement|review|code_generation"| Med[Sonnet-4 + medium effort]
    Check -->|skill_invocation| Skill[Parse SKILL.md model: field]
    Skill -->|model found| Custom[Use skill's preferred model + medium]
    Skill -->|no model in SKILL.md| Fallback[Sonnet-4 + medium]
    Check -->|"typo|read|simple|qa_response"| Low[Gemini-3.5-Flash + low effort]
    Check -->|no match| Fallback2[Sonnet-4 + medium]
```

## 8. End-to-End Flow (Claude → CodeAtlas → A2A → Backend)

```mermaid
sequenceDiagram
    participant User as User
    participant Claude as Claude Code CLI
    participant MCP as MCP Server (codeatlas)
    participant Service as CodeAtlas Service
    participant A2A as A2A Endpoint
    participant Oracle as Oracle 26ai

    User->>Claude: query or task
    Claude->>MCP: use MCP tool (e.g., analyze, search_genome)
    MCP->>Service: route to handler
    Service->>Oracle: query with tenant_id filter
    Oracle-->>Service: tenant-scoped data
    Service-->>MCP: result
    MCP-->>Claude: JSON response
    Claude-->>User: answer

    alt Delegation to another agent
        Claude->>MCP: a2a_delegate_task(url, tool, params)
        MCP->>A2A: POST /a2a/jsonrpc (with auth)
        A2A->>A2A: execute tool
        A2A-->>MCP: task completed
        MCP-->>Claude: artifact
    end
```

---

## 9. A2A Orchestration Flow (Leader-Developer Workflow)

### Task State Machine

```mermaid
stateDiagram-v2
    [*] --> created: Leader creates task
    created --> assigned: Leader assigns task
    assigned --> implemented: Developer implements task
    implemented --> fixes_needed: Leader requests fixes (with feedback)
    implemented --> approved: Leader approves task
    fixes_needed --> implemented: Developer submits fixes
    approved --> [*]
```

### Orchestration Sequence Flow

```mermaid
sequenceDiagram
    participant Leader as Leader Agent
    participant Orch as A2AOrchestrationService
    participant Dev as Developer Agent
    participant Task as Task State
    participant Repo as Code Repository

    Leader->>Orch: a2a_create_orchestration_task(desc, dev_id)
    Orch->>Task: created (or assigned if dev_id)
    Orch-->>Leader: orchestration_task_id

    Leader->>Orch: a2a_assign_orchestration_task(id, dev_id)
    Orch->>Task: assigned
    Orch-->>Leader: updated state

    Note over Dev: Developer picks up assigned task

    Dev->>Orch: a2a_implement_orchestration_task(id, artifacts)
    Orch->>Task: implemented
    Orch-->>Dev: updated state

    Dev->>Repo: Open PR / commit changes

    Leader->>Orch: a2a_review_orchestration_task(id, approved=false, feedback)
    Orch->>Task: fixes_needed
    Orch-->>Leader: updated state + feedback

    Note over Dev: Developer reads feedback

    Dev->>Orch: a2a_submit_fixes_orchestration_task(id, new_artifacts)
    Orch->>Task: implemented (ready for re-review)
    Orch-->>Dev: updated state

    Leader->>Orch: a2a_review_orchestration_task(id, approved=true)
    Orch->>Task: approved
    Orch-->>Leader: final state

    Leader->>Repo: Merge PR
```

### Orchestration Tools Summary

| Tool | Role | Description |
|------|------|-------------|
| `a2a_create_orchestration_task` | Leader | Create task (`created` or `assigned`) |
| `a2a_assign_orchestration_task` | Leader | Assign task to developer (`assigned`) |
| `a2a_implement_orchestration_task` | Developer | Report implementation (`implemented`) |
| `a2a_review_orchestration_task` | Leader | Review or approve (`implemented` → `approved` or `fixes_needed`) |
| `a2a_submit_fixes_orchestration_task` | Developer | Submit fixes (`fixes_needed` → `implemented`) |
| `a2a_get_orchestration_task` | Generic | Get task status and details |

### Orchestration Data Model

```typescript
A2AOrchestrationTask {
  orchestrationTaskId: string
  tenantId: string          // tenant isolation
  leaderAgentId: string
  developerAgentId?: string
  state: OrchestrationState // created | assigned | implemented | fixes_needed | approved
  description: string
  toolName?: string         // MCP tool for developer
  toolParams?: Record<string, unknown>
  artifacts?: Artifact[]    // implementation outputs
  feedback?: string         // leader review feedback
  prUrl?: string
  reviewBotFindings?: string
  stateHistory: { state, timestamp, note }[]  // audit trail
}
```
