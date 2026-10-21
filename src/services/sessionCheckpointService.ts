import { createHash } from 'node:crypto';
import { createDatabaseAdapter } from '../database/factory.js';
import { authStorage } from '../utils/context.js';
import { checkNoiseBlocklist } from './noiseBlocklist.js';
import { redactMemoryText } from './structuredMemoryExtractor.js';

export interface SessionCheckpoint {
  id: string;
  project_id: string;
  session_id: string;
  active_task: string;
  completed: string[];
  decisions: string[];
  blockers: string[];
  next_actions: string[];
  source_event_ids: string[];
  source_session_ids: string[];
  created_at: string;
  verification_status: 'source_grounded';
}

export interface CheckpointWrite {
  projectId: string;
  sessionId: string;
  sourceEventIds: string[];
  activeTask?: string;
  completed?: string[];
  decisions?: string[];
  blockers?: string[];
  nextActions?: string[];
}

interface CaptureRow {
  event_id: string;
  session_id: string;
  actor_role: string | null;
  memory_type_hint: string | null;
  content_redacted: string;
  checkpoint_json: string | null;
  created_at: string;
  capture_sequence: number | null;
}

function tenantId(): string {
  const uid = authStorage.getStore()?.uid;
  if (!uid) throw new Error('Authentication required for checkpoints');
  return uid;
}

function safeText(value: string, limit = 1600): string {
  return redactMemoryText(value)
    .replace(/^\[(?:USER|ASSISTANT|TOOL)\]\s*/i, '')
    .trim().slice(0, limit);
}

function successfulTool(row: CaptureRow): boolean {
  return row.actor_role === 'TOOL' && row.memory_type_hint !== 'MISTAKE' &&
    !/outcome:\s*failed|exit_code\s*=\s*[1-9]\d*/i.test(row.content_redacted) &&
    /exit_code\s*=\s*0\b|\b\d+\s+tests?\s+passed\b/i.test(row.content_redacted);
}

function derive(rows: CaptureRow[]): Pick<SessionCheckpoint, 'active_task' | 'completed' | 'decisions' | 'blockers' | 'next_actions'> {
  const user = rows.filter(row => row.actor_role === 'USER' && safeText(row.content_redacted).length >= 20 && !checkNoiseBlocklist(row.content_redacted).isNoise);
  const unique = (items: string[]): string[] => [...new Set(items)].slice(-8);
  return {
    active_task: user.length ? safeText(user[user.length - 1].content_redacted) : '',
    completed: unique(rows.filter(successfulTool).map(row => safeText(row.content_redacted))),
    decisions: unique(user.filter(row => /\b(decision|decided|chose|chosen|agreed)\b|quyết định|đã chọn/iu.test(row.content_redacted)).map(row => safeText(row.content_redacted))),
    blockers: unique(rows.filter(row =>
      (row.actor_role === 'TOOL' && (row.memory_type_hint === 'MISTAKE' || /outcome:\s*failed|exit_code\s*=\s*[1-9]\d*/i.test(row.content_redacted))) ||
      (row.actor_role === 'USER' && /\b(blocked|blocker|cannot proceed)\b|bị chặn|chưa thể/iu.test(row.content_redacted))
    ).map(row => safeText(row.content_redacted))),
    next_actions: unique(user.filter(row => /\b(next|remaining|still need)\b|tiếp theo|còn lại|chưa hoàn thành/iu.test(row.content_redacted)).map(row => safeText(row.content_redacted))),
  };
}

async function initialize(): Promise<void> {
  await createDatabaseAdapter().execute(`CREATE TABLE IF NOT EXISTS dream_session_checkpoints (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_checkpoint_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, project_id, source_checkpoint_id)
  )`);
}

async function persist(projectId: string, sessionId: string, sourceCheckpointId: string, rows: CaptureRow[], overrides: Partial<Pick<SessionCheckpoint, 'active_task' | 'completed' | 'decisions' | 'blockers' | 'next_actions'>> = {}, createdAt?: string): Promise<SessionCheckpoint> {
  const tenant = tenantId();
  const id = `checkpoint_${createHash('sha256').update(JSON.stringify([tenant, projectId, sourceCheckpointId])).digest('hex')}`;
  const checkpoint: SessionCheckpoint = {
    id,
    project_id: projectId,
    session_id: sessionId,
    ...derive(rows),
    ...overrides,
    source_event_ids: rows.map(row => row.event_id),
    source_session_ids: [...new Set(rows.map(row => row.session_id))],
    created_at: createdAt || new Date().toISOString(),
    verification_status: 'source_grounded',
  };
  await createDatabaseAdapter().execute(`INSERT INTO dream_session_checkpoints
    (id, tenant_id, project_id, session_id, source_checkpoint_id, payload_json, created_at)
    VALUES (:id, :tenant, :projectId, :sessionId, :sourceCheckpointId, :payload, :createdAt)
    ON CONFLICT (tenant_id, project_id, source_checkpoint_id) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
  { id, tenant, projectId, sessionId, sourceCheckpointId, payload: JSON.stringify(checkpoint), createdAt: checkpoint.created_at });
  const saved = await createDatabaseAdapter().query<{ payload_json: string }>('SELECT payload_json FROM dream_session_checkpoints WHERE id = :id AND tenant_id = :tenant', { id, tenant });
  if (!saved.length) throw new Error('Checkpoint persistence was not confirmed');
  return JSON.parse(saved[0].payload_json) as SessionCheckpoint;
}

export class SessionCheckpointService {
  /** Restore deterministic source-grounded progress without an embedding lookup. */
  static async latest(projectId: string): Promise<SessionCheckpoint | null> {
    const tenant = tenantId();
    await initialize();
    const db = createDatabaseAdapter();
    const markers = await db.query<CaptureRow>(`SELECT event_id, session_id, actor_role, memory_type_hint, content_redacted, checkpoint_json, created_at, capture_sequence
      FROM dream_capture_events WHERE tenant_id = :tenant AND project_id = :projectId AND checkpoint_json IS NOT NULL
      ORDER BY capture_sequence DESC, event_id DESC LIMIT 20`, { tenant, projectId });
    const eligibleMarkers = markers.filter(row => {
      try {
        const checkpoint = JSON.parse(row.checkpoint_json || 'null') as Record<string, unknown> | null;
        return checkpoint?.trigger === 'Stop' || checkpoint?.trigger === 'PreCompact' || checkpoint?.kind === 'SESSION_CHECKPOINT';
      } catch { return false; }
    });
    for (const marker of eligibleMarkers) {
      const sequence = marker.capture_sequence == null ? Number.NaN : Number(marker.capture_sequence);
      const markerBound = Number.isFinite(sequence)
        ? 'capture_sequence <= :captureSequence'
        : 'created_at <= :cutoff';
      const rows = await db.query<CaptureRow>(`SELECT event_id, session_id, actor_role, memory_type_hint, content_redacted, checkpoint_json, created_at, capture_sequence
        FROM dream_capture_events WHERE tenant_id = :tenant AND project_id = :projectId AND session_id = :sessionId AND ${markerBound}
        ORDER BY capture_sequence DESC, event_id DESC LIMIT 200`, {
        tenant, projectId, sessionId: marker.session_id,
        ...(Number.isFinite(sequence) ? { captureSequence: sequence } : { cutoff: marker.created_at }),
      });
      rows.reverse();
      const progress = derive(rows);
      if (!progress.active_task && !progress.completed.length && !progress.decisions.length && !progress.blockers.length && !progress.next_actions.length) continue;
      return persist(projectId, marker.session_id, marker.event_id, rows, {}, marker.created_at);
    }
    const saved = await db.query<{ payload_json: string }>(`SELECT payload_json FROM dream_session_checkpoints
      WHERE tenant_id = :tenant AND project_id = :projectId ORDER BY created_at DESC, id DESC LIMIT 1`, { tenant, projectId });
    return saved.length ? JSON.parse(saved[0].payload_json) as SessionCheckpoint : null;
  }

  /** Explicit writes must quote source events in the same authenticated scope. */
  static async save(input: CheckpointWrite): Promise<SessionCheckpoint> {
    const tenant = tenantId();
    if (!input.projectId?.trim() || !input.sessionId?.trim() || !Array.isArray(input.sourceEventIds) || !input.sourceEventIds.length || input.sourceEventIds.length > 200 || input.sourceEventIds.some(id => typeof id !== 'string' || !id)) throw new Error('Checkpoint source evidence is required');
    await initialize();
    const ids = [...new Set(input.sourceEventIds)];
    const binds: Record<string, unknown> = { tenant, projectId: input.projectId, sessionId: input.sessionId };
    const placeholders = ids.map((id, index) => { binds[`source${index}`] = id; return `:source${index}`; });
    const rows = await createDatabaseAdapter().query<CaptureRow>(`SELECT event_id, session_id, actor_role, memory_type_hint, content_redacted, checkpoint_json, created_at, capture_sequence
      FROM dream_capture_events WHERE tenant_id = :tenant AND project_id = :projectId AND session_id = :sessionId AND event_id IN (${placeholders.join(',')})
      ORDER BY created_at ASC, event_id ASC`, binds);
    if (rows.length !== ids.length) throw new Error('Checkpoint source evidence is missing or belongs to a different scope');
    const overrides: Partial<Pick<SessionCheckpoint, 'active_task' | 'completed' | 'decisions' | 'blockers' | 'next_actions'>> = {};
    const fields = [['activeTask', 'active_task'], ['completed', 'completed'], ['decisions', 'decisions'], ['blockers', 'blockers'], ['nextActions', 'next_actions']] as const;
    for (const [inputField, outputField] of fields) {
      const value = input[inputField];
      if (value === undefined) continue;
      const items = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(items) || items.length > 8 || items.some(item => typeof item !== 'string' || !item || item.length > 1600)) throw new Error('Invalid checkpoint evidence field');
      for (const item of items) {
        const permitted = outputField === 'completed' ? rows.filter(successfulTool) : rows.filter(row => row.actor_role === 'USER' || (outputField === 'blockers' && row.actor_role === 'TOOL'));
        if (!permitted.some(row => safeText(row.content_redacted).includes(safeText(item)))) throw new Error('Unsupported checkpoint claim: cited evidence does not support the field');
      }
      if (outputField === 'active_task') overrides.active_task = safeText(items[0] || '');
      else overrides[outputField] = items.map(item => safeText(item));
    }
    const sourceId = `explicit_${createHash('sha256').update(JSON.stringify([ids.sort(), overrides])).digest('hex')}`;
    return persist(input.projectId, input.sessionId, sourceId, rows, overrides);
  }
}
