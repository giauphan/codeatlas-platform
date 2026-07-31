-- A2A Agent Registry — Oracle 26ai DDL
-- Stores agent discovery info so CodeAtlas can find and communicate with other A2A agents.

CREATE TABLE agent_registry (
  agent_id        VARCHAR2(128) PRIMARY KEY,
  agent_url       VARCHAR2(512) NOT NULL,
  agent_name      VARCHAR2(256),
  agent_card_json CLOB,             -- Full AgentCard JSON from /.well-known/agent-card.json
  capabilities    CLOB,             -- JSON array of skill/capability IDs
  status          VARCHAR2(16) DEFAULT 'online' CHECK (status IN ('online', 'offline', 'busy', 'degraded')),
  last_heartbeat  TIMESTAMP DEFAULT SYSTIMESTAMP,
  registered_at   TIMESTAMP DEFAULT SYSTIMESTAMP,
  metadata_json   CLOB              -- JSON: model, version, owner, tenant
);

CREATE INDEX idx_agent_registry_status ON agent_registry(status);
CREATE INDEX idx_agent_registry_heartbeat ON agent_registry(last_heartbeat);

-- Usage notes:
-- 1. Agents register on startup via POST /a2a/register
-- 2. Heartbeat ping every 30s updates last_heartbeat
-- 3. Agents with last_heartbeat > 2 minutes are auto-marked 'offline'
-- 4. Discovery queries filter by status + capability keyword
