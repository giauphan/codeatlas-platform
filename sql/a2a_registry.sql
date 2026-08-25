-- A2A Agent Registry — SQLite schema
-- Stores agent discovery info so CodeAtlas can find and communicate with other A2A agents.
-- The registry currently runs in memory; this schema documents the persistent shape.

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id        TEXT PRIMARY KEY,
  agent_url       TEXT NOT NULL,
  agent_name      TEXT,
  agent_card_json TEXT,             -- Full AgentCard JSON from /.well-known/agent-card.json
  capabilities    TEXT,             -- JSON array of skill/capability IDs
  status          TEXT DEFAULT 'online' CHECK (status IN ('online', 'offline', 'busy', 'degraded')),
  last_heartbeat  TEXT DEFAULT (datetime('now')),
  registered_at   TEXT DEFAULT (datetime('now')),
  metadata_json   TEXT              -- JSON: model, version, owner, tenant
);

CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);
CREATE INDEX IF NOT EXISTS idx_agent_registry_heartbeat ON agent_registry(last_heartbeat);

-- Usage notes:
-- 1. Agents register on startup via POST /a2a/register
-- 2. Heartbeat ping every 30s updates last_heartbeat
-- 3. Agents with last_heartbeat > 2 minutes are auto-marked 'offline'
-- 4. Discovery queries filter by status + capability keyword