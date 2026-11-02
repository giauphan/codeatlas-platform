import { createHash } from 'node:crypto';
import { createDatabaseAdapter } from '../database/factory.js';
import { authStorage } from '../utils/context.js';
import { DreamCaptureStore, type PendingCaptureEvent } from './dreamCaptureStore.js';
import { DreamingService } from './dreamingService.js';
import { extractStructuredMemoriesWithOutcome, redactMemoryText, validateGroundedCandidates, type ExtractionSourceEvent, type StructuredExtractionOutcome, type StructuredMemory } from './structuredMemoryExtractor.js';
import { SessionCheckpointService } from './sessionCheckpointService.js';
import { DreamDiagnostics } from './dreamDiagnostics.js';

const EXTRACTOR_VERSION = 'grounded-v1';
const MODEL_EXTRACTOR_VERSION = `${EXTRACTOR_VERSION}:model`;
type Fence = { jobKey: string; ownerToken: string; fencingToken: number };
export interface ReconciliationOptions {
  tenantId?: string;
  projectId?: string;
  eventId?: string;
  limit?: number;
  runFence?: Fence;
  generate?: (prompt: string) => Promise<string>;
  useModel?: boolean;
}
export interface ReconciliationResult {
  success: boolean;
  events_processed: number;
  events_filtered: number;
  stored: number;
  duplicate: number;
  failed: number;
  memory_ids: string[];
  skipped?: true;
  reason_code?: 'processing_disabled';
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

// Supersession is intentionally conservative: an explicit change, the same
// named topic, and a newer user source are all required. Other facts stay active.
function preferenceTopic(memory: StructuredMemory): string | null {
  if (memory.kind !== 'PREFERENCE' && memory.kind !== 'DECISION') return null;
  const match = memory.content.match(/\bfor\s+([^.!?\n]+)|(?:cho|về)\s+([^.!?\n]+)/iu);
  return match ? `${memory.kind}:${(match[1] || match[2]).normalize('NFC').toLowerCase().trim()}` : null;
}
function isExplicitChange(memory: StructuredMemory, event: PendingCaptureEvent): boolean {
  return event.actorRole === 'USER' && memory.certainty === 'explicit' &&
    /\b(now prefer|now want|changed? (?:my|our|the) (?:preference|decision)|updated decision|instead of|no longer)\b|(?:bây giờ|đổi quyết định|thay đổi|thay vì|không còn)/iu.test(memory.content);
}

export class MemoryIngestionService {
  private static async requireFence(fence?: Fence): Promise<void> {
    if (!fence) return;
    const auth = authStorage.getStore();
    const rows = await createDatabaseAdapter().query(
      `SELECT job_key FROM dream_job_runs WHERE job_key = :jobKey AND tenant_id = :tenantId
       AND owner_token = :ownerToken AND fencing_token = :fencingToken AND state = 'running' AND lease_until > :now`,
      { ...fence, tenantId: auth?.uid, now: new Date().toISOString() },
    );
    if (rows.length !== 1) throw new Error('Scheduled reconciliation lease is no longer current');
  }

  static async processPending(options: ReconciliationOptions = {}): Promise<ReconciliationResult> {
    const result: ReconciliationResult = { success: true, events_processed: 0, events_filtered: 0, stored: 0, duplicate: 0, failed: 0, memory_ids: [] };
    const auth = authStorage.getStore();
    if (!auth) throw new Error('Auth context required for reconciliation');
    const startedAt = Date.now();
    let lagMs = 0;
    const recordMetrics = () => DreamDiagnostics.recordReconciliation({
      processed: result.events_processed,
      filtered: result.events_filtered,
      failed: result.failed,
      durationMs: Date.now() - startedAt,
      lagMs,
    });
    if (process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED?.toLowerCase() === 'false') {
      recordMetrics();
      return { ...result, skipped: true, reason_code: 'processing_disabled' };
    }
    let events: PendingCaptureEvent[];
    try {
      events = await DreamCaptureStore.reconcilePending(options);
    } catch (error) {
      result.failed = 1;
      result.success = false;
      recordMetrics();
      throw error;
    }
    const now = Date.now();
    lagMs = events.reduce((maximum, event) => {
      const created = Date.parse(event.createdAt);
      return Number.isFinite(created) ? Math.max(maximum, Math.max(0, now - created)) : maximum;
    }, 0);
    // Checkpoint decisions cover all pending source events up to their marker.
    // Run markers before standalone events so a checkpoint can curate a batch
    // before the same pending events are extracted by the deterministic path.
    events.sort((left, right) => Number(right.checkpoint !== undefined) - Number(left.checkpoint !== undefined) || left.captureSequence - right.captureSequence || left.eventId.localeCompare(right.eventId));
    const completedInRun = new Set<string>();
    for (const event of events) {
      if (completedInRun.has(event.eventId)) continue;
      const eventAuth = { ...auth, uid: event.tenantId };
      await authStorage.run(eventAuth, async () => {
      try {
        await this.requireFence(options.runFence);
        const projectId = event.projectId || event.project;
        if (event.checkpoint !== undefined) await SessionCheckpointService.latest(projectId);
        const batch = event.checkpoint === undefined ? [event] : await this.checkpointBatch(event);
        const pendingSources = await this.pendingBatchSources(event, projectId, batch);
        if (!pendingSources.length) return;
        const sourceEvents: ExtractionSourceEvent[] = batch.map(source => ({ id: source.eventId, role: source.actorRole || 'USER', text: source.content }));
        const sourceHash = digest(JSON.stringify({
          tenantId: event.tenantId,
          projectId,
          markerEventId: event.eventId,
          markerSequence: event.captureSequence,
          checkpoint: event.checkpoint,
          sources: sourceEvents.map(source => [source.id, source.role, source.text]),
        }));
        const generator = options.generate ?? (options.useModel && event.checkpoint !== undefined
          ? (await import('./llmService.js')).createMemoryExtractionGenerator?.()
          : undefined);
        let outcome: StructuredExtractionOutcome;
        if (event.checkpoint !== undefined) {
          const receipt = await this.readModelReceipt(event, projectId, sourceHash, sourceEvents);
          if (receipt) outcome = receipt;
          else if (!generator) {
            outcome = await extractStructuredMemoriesWithOutcome(sourceEvents, { checkpoint: event.checkpoint });
          }
          else {
            outcome = await extractStructuredMemoriesWithOutcome(sourceEvents, { checkpoint: event.checkpoint, generate: generator });
            if (outcome.mode === 'model') outcome = await this.saveModelReceipt(event, projectId, sourceHash, sourceEvents, outcome);
          }
        } else {
          outcome = await extractStructuredMemoriesWithOutcome(sourceEvents, { checkpoint: event.checkpoint, generate: generator });
        }
        if (event.checkpoint !== undefined && outcome.mode === 'deterministic') {
          const pendingIds = new Set(pendingSources.map(source => source.eventId));
          outcome = { ...outcome, memories: outcome.memories.filter(memory => memory.evidence.every(evidence => pendingIds.has(evidence.sourceEventId))) };
        }
        const memories = outcome.memories;
        const memoryIds: string[] = [];
        const memoryIdsBySource = new Map<string, string[]>();
        for (const memory of memories) {
          await this.requireFence(options.runFence);
          const sources = batch.filter(source => memory.evidence.some(item => item.sourceEventId === source.eventId));
          if (!sources.length) throw new Error('Missing source evidence');
          const source = sources[0];
          const key = digest(`${EXTRACTOR_VERSION}\0${sources.map(item => item.eventId).sort().join('\0')}\0${memory.kind}\0${memory.content}`);
          const ack = await DreamingService.saveDreamMemoryWithAck({
            project: event.project, projectId, displayName: event.displayName, workspacePath: event.workspacePath,
            sessionId: source.sessionId, memoryType: memory.memoryType, content: memory.content, importance: memory.importance,
            idempotencyKey: `extract:${key}`, aiModel: EXTRACTOR_VERSION,
            structuredEvidence: { memory, events: sources.map(item => ({ id: item.eventId, role: item.actorRole || 'USER', text: item.content })) },
          });
          if (ack.status === 'filtered') continue;
          if (!ack.persisted || !ack.id) throw new Error('Memory persistence was not acknowledged');
          for (const source of sources) {
            await this.persistEvidence(ack.id, { ...memory, evidence: memory.evidence.filter(item => item.sourceEventId === source.eventId) }, source, outcome.mode === 'model');
            const ids = memoryIdsBySource.get(source.eventId) ?? [];
            ids.push(ack.id);
            memoryIdsBySource.set(source.eventId, ids);
          }
          if (ack.status === 'stored') result.stored++;
          else result.duplicate++;
          memoryIds.push(ack.id);
        }
        await this.requireFence(options.runFence);
        if (outcome.mode === 'model') {
          await this.retireUnselectedBatchMemories(event, projectId, batch.map(source => source.eventId), memoryIds);
        }
        if (outcome.mode === 'model') {
          for (const source of batch.filter(item => !pendingSources.some(pending => pending.eventId === item.eventId))) {
            const sourceMemoryIds = [...new Set(memoryIdsBySource.get(source.eventId) ?? [])];
            await createDatabaseAdapter().execute(
              `UPDATE dream_capture_events SET status = :status, memory_ids_json = :memoryIds
               WHERE tenant_id = :tenantId AND project_id = :projectId AND event_id = :eventId AND status IN ('processed', 'filtered')`,
              { tenantId: event.tenantId, projectId, eventId: source.eventId, status: sourceMemoryIds.length ? 'processed' : 'filtered', memoryIds: JSON.stringify(sourceMemoryIds) },
            );
          }
        }
        // Every pending source in this exact checkpoint batch has now been
        // fully extracted and its evidence persisted. Mark only rows that are
        // still pending, with IDs that were actually acknowledged as persisted.
        for (const source of pendingSources) {
          const sourceMemoryIds = [...new Set(memoryIdsBySource.get(source.eventId) ?? [])];
          const updated = await createDatabaseAdapter().execute(
            `UPDATE dream_capture_events SET status = :status, memory_ids_json = :memoryIds
             WHERE tenant_id = :tenantId AND project_id = :projectId AND event_id = :eventId AND status = 'pending'`,
            { tenantId: event.tenantId, projectId, eventId: source.eventId, status: sourceMemoryIds.length ? 'processed' : 'filtered', memoryIds: JSON.stringify(sourceMemoryIds) },
          );
          completedInRun.add(source.eventId);
          if (updated.rowsAffected > 0) {
            if (sourceMemoryIds.length) result.events_processed++;
            else result.events_filtered++;
          }
        }
        result.memory_ids.push(...memoryIds);
      } catch {
        // A partially saved event stays pending. Unique receipts and evidence
        // keys let the next worker finish it without inflating counts.
        result.failed++;
        result.success = false;
      }
      });
    }
    result.memory_ids = [...new Set(result.memory_ids)];
    recordMetrics();
    return result;
  }

  private static async pendingBatchSources(event: PendingCaptureEvent, projectId: string, batch: PendingCaptureEvent[]): Promise<PendingCaptureEvent[]> {
    const sourceIds = [...new Set(batch.map(source => source.eventId))];
    if (!sourceIds.length) return [];
    const binds: Record<string, unknown> = { tenantId: event.tenantId, projectId, sessionId: event.sessionId };
    const placeholders = sourceIds.map((id, index) => {
      const key = `source${index}`;
      binds[key] = id;
      return `:${key}`;
    });
    const rows = await createDatabaseAdapter().query<{ event_id: string }>(
      `SELECT event_id FROM dream_capture_events WHERE tenant_id = :tenantId AND project_id = :projectId AND session_id = :sessionId
       AND status = 'pending' AND content_redacted <> '[SOURCE_EXPIRED]' AND event_id IN (${placeholders.join(',')})`,
      binds,
    );
    const pending = new Set(rows.map(row => String(row.event_id)));
    return batch.filter(source => pending.has(source.eventId));
  }

  private static async ensureModelReceiptTable(): Promise<void> {
    await createDatabaseAdapter().execute(`CREATE TABLE IF NOT EXISTS dream_extraction_receipts (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      marker_event_id TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, marker_event_id, extractor_version, source_hash)
    )`);
  }

  private static validateModelReceipt(value: unknown, sourceEvents: ExtractionSourceEvent[]): StructuredExtractionOutcome | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (item.mode !== 'model' || !Array.isArray(item.memories) || !Number.isInteger(item.rejectedCandidates) || Number(item.rejectedCandidates) < 0) return null;
    const memories = validateGroundedCandidates(item.memories, sourceEvents);
    if (memories.length !== item.memories.length) return null;
    for (let index = 0; index < memories.length; index += 1) {
      const stored = item.memories[index] as Record<string, unknown>;
      if (stored.status !== undefined) {
        if (stored.status !== 'active' && stored.status !== 'superseded') return null;
        memories[index].status = stored.status;
      }
      if (stored.supersedes !== undefined) {
        if (!Array.isArray(stored.supersedes)) return null;
        const supersedes: StructuredMemory['supersedes'] = [];
        for (const raw of stored.supersedes) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          const reference = raw as Record<string, unknown>;
          if (typeof reference.sourceEventId !== 'string' || typeof reference.span !== 'string' || !reference.span) return null;
          const source = sourceEvents.find(event => event.id === reference.sourceEventId);
          const quote = redactMemoryText(reference.span).trim();
          if (!source || quote !== reference.span || !redactMemoryText(source.text).includes(quote)) return null;
          supersedes.push({ sourceEventId: reference.sourceEventId, span: quote });
        }
        memories[index].supersedes = supersedes;
      }
    }
    return { memories, mode: 'model', rejectedCandidates: Number(item.rejectedCandidates) };
  }

  private static async readModelReceipt(event: PendingCaptureEvent, projectId: string, sourceHash: string, sourceEvents: ExtractionSourceEvent[]): Promise<StructuredExtractionOutcome | null> {
    await this.ensureModelReceiptTable();
    const db = createDatabaseAdapter();
    const key = { tenantId: event.tenantId, projectId, markerEventId: event.eventId, version: EXTRACTOR_VERSION, sourceHash };
    const rows = await db.query<{ outcome_json: string }>(`SELECT outcome_json FROM dream_extraction_receipts
      WHERE tenant_id = :tenantId AND project_id = :projectId AND marker_event_id = :markerEventId
        AND extractor_version = :version AND source_hash = :sourceHash`, key);
    if (!rows.length) return null;
    try {
      const outcome = this.validateModelReceipt(JSON.parse(rows[0].outcome_json), sourceEvents);
      if (outcome) return outcome;
    } catch { /* Invalid receipts are discarded and regenerated from current evidence. */ }
    await db.execute(`DELETE FROM dream_extraction_receipts WHERE tenant_id = :tenantId AND project_id = :projectId
      AND marker_event_id = :markerEventId AND extractor_version = :version AND source_hash = :sourceHash`, key);
    return null;
  }

  private static async saveModelReceipt(event: PendingCaptureEvent, projectId: string, sourceHash: string, sourceEvents: ExtractionSourceEvent[], outcome: StructuredExtractionOutcome): Promise<StructuredExtractionOutcome> {
    await this.ensureModelReceiptTable();
    const db = createDatabaseAdapter();
    const key = { tenantId: event.tenantId, projectId, markerEventId: event.eventId, version: EXTRACTOR_VERSION, sourceHash };
    await db.execute(`INSERT INTO dream_extraction_receipts
      (tenant_id, project_id, marker_event_id, extractor_version, source_hash, outcome_json, created_at)
      VALUES (:tenantId, :projectId, :markerEventId, :version, :sourceHash, :outcome, :createdAt)
      ON CONFLICT (tenant_id, project_id, marker_event_id, extractor_version, source_hash) DO NOTHING`,
    { ...key, outcome: JSON.stringify(outcome), createdAt: new Date().toISOString() });
    const saved = await this.readModelReceipt(event, projectId, sourceHash, sourceEvents);
    if (!saved) throw new Error('Model extraction receipt was not persisted or did not validate');
    return saved;
  }

  private static async retireUnselectedBatchMemories(event: PendingCaptureEvent, projectId: string, sourceIds: string[], selectedMemoryIds: string[]): Promise<void> {
    if (!sourceIds.length) return;
    const binds: Record<string, unknown> = { tenantId: event.tenantId, projectId, version: EXTRACTOR_VERSION };
    const sourcePlaceholders = sourceIds.map((id, index) => { const key = `source${index}`; binds[key] = id; return `:${key}`; });
    const retained = new Set(selectedMemoryIds);
    const candidates = await createDatabaseAdapter().query<{ id: string }>(
      `SELECT DISTINCT memory.id FROM ai_dreaming_memory memory
       JOIN dream_memory_evidence evidence ON evidence.tenant_id = memory.tenant_id AND evidence.project_id = :projectId AND evidence.memory_id = memory.id
       JOIN dream_memory_provenance provenance ON provenance.tenant_id = memory.tenant_id AND provenance.project_id = :projectId AND provenance.memory_id = memory.id
       WHERE memory.tenant_id = :tenantId AND memory.project_id = :projectId AND memory.status = 'active'
         AND provenance.extractor_version = :version AND provenance.superseded_by IS NULL
         AND evidence.source_event_id IN (${sourcePlaceholders.join(',')})`,
      binds,
    );
    for (const row of candidates) {
      if (retained.has(row.id)) continue;
      await createDatabaseAdapter().execute(
        `UPDATE ai_dreaming_memory SET status = 'superseded', updated_at = :now
         WHERE tenant_id = :tenantId AND project_id = :projectId AND id = :memoryId AND status = 'active'`,
        { tenantId: event.tenantId, projectId, memoryId: row.id, now: new Date().toISOString() },
      );
    }
  }

  private static async checkpointBatch(event: PendingCaptureEvent): Promise<PendingCaptureEvent[]> {
    const sequence = Number(event.captureSequence);
    const markerBound = Number.isFinite(sequence)
      ? 'capture_sequence <= :captureSequence'
      : 'created_at <= :cutoff';
    const rows = await createDatabaseAdapter().query<Record<string, unknown>>(
      `SELECT event_id, actor_role, content_redacted, tool_name, occurred_at, source_spans_json, capture_sequence, created_at
       FROM dream_capture_events WHERE tenant_id = :tenantId AND project_id = :projectId AND session_id = :sessionId
         AND ${markerBound} AND content_redacted <> '[SOURCE_EXPIRED]'
       ORDER BY capture_sequence DESC, event_id DESC LIMIT 100`,
      {
        tenantId: event.tenantId, projectId: event.projectId || event.project, sessionId: event.sessionId,
        ...(Number.isFinite(sequence) ? { captureSequence: sequence } : { cutoff: event.createdAt }),
      },
    );
    // Keep the newest complete events that fit, then restore chronological order.
    let budget = 48_000;
    const result: PendingCaptureEvent[] = [];
    for (const row of rows) {
      const text = String(row.content_redacted);
      if (text.length > budget) continue;
      budget -= text.length;
      result.push({ ...event, eventId: String(row.event_id), captureSequence: Number(row.capture_sequence), createdAt: String(row.created_at), actorRole: row.actor_role === 'TOOL' || row.actor_role === 'ASSISTANT' ? row.actor_role : 'USER', content: text,
        toolName: row.tool_name == null ? undefined : String(row.tool_name), occurredAt: row.occurred_at == null ? undefined : String(row.occurred_at),
        sourceSpans: row.source_spans_json ? JSON.parse(String(row.source_spans_json)) : undefined });
    }
    return result.reverse();
  }

  private static async persistEvidence(memoryId: string, memory: StructuredMemory, event: PendingCaptureEvent, authoritativeModel = false): Promise<void> {
    const db = createDatabaseAdapter();
    const projectId = event.projectId || event.project;
    const occurredAt = event.occurredAt && Number.isFinite(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : new Date().toISOString();
    const topic = preferenceTopic(memory);
    const provenanceVersion = authoritativeModel ? MODEL_EXTRACTOR_VERSION : EXTRACTOR_VERSION;
    await db.execute(
      `INSERT INTO dream_memory_provenance (tenant_id, project_id, memory_id, kind, certainty, base_confidence, extractor_version, topic_key, occurred_at)
       VALUES (:tenantId, :projectId, :memoryId, :kind, :certainty, :confidence, :version, :topic, :occurredAt)
       ON CONFLICT (tenant_id, project_id, memory_id) DO NOTHING`,
      { tenantId: event.tenantId, projectId, memoryId, kind: memory.kind, certainty: memory.certainty, confidence: memory.confidence, version: provenanceVersion, topic, occurredAt },
    );
    if (authoritativeModel) {
      await db.execute(
        `UPDATE dream_memory_provenance SET kind = :kind, certainty = :certainty, base_confidence = :confidence, topic_key = :topic, occurred_at = :occurredAt, extractor_version = :modelVersion
         WHERE tenant_id = :tenantId AND project_id = :projectId AND memory_id = :memoryId AND extractor_version IN (:deterministicVersion, :modelVersion)`,
        { tenantId: event.tenantId, projectId, memoryId, kind: memory.kind, certainty: memory.certainty, confidence: memory.confidence, topic, occurredAt, deterministicVersion: EXTRACTOR_VERSION, modelVersion: MODEL_EXTRACTOR_VERSION },
      );
    }
    for (const evidence of memory.evidence) {
      if (evidence.sourceEventId !== event.eventId) throw new Error('Invalid evidence source');
      await db.execute(
        `INSERT INTO dream_memory_evidence (tenant_id, project_id, memory_id, source_event_id, evidence_hash, session_id, actor_role, tool_name, span, source_spans_json, occurred_at)
         VALUES (:tenantId, :projectId, :memoryId, :sourceId, :hash, :sessionId, :role, :tool, :span, :sourceSpans, :occurredAt)
         ON CONFLICT DO NOTHING`,
        { tenantId: event.tenantId, projectId, memoryId, sourceId: event.eventId, hash: digest(evidence.span), sessionId: event.sessionId, role: event.actorRole || 'USER', tool: event.toolName || null, span: evidence.span, sourceSpans: JSON.stringify(event.sourceSpans || []), occurredAt },
      );
    }
    const counts = await db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT source_event_id) AS count FROM dream_memory_evidence WHERE tenant_id = :tenantId AND project_id = :projectId AND memory_id = :memoryId`,
      { tenantId: event.tenantId, projectId, memoryId },
    );
    const count = Number(counts[0]?.count || 1);
    const provenance = await db.query<{ base_confidence: number }>(
      'SELECT base_confidence FROM dream_memory_provenance WHERE tenant_id = :tenantId AND project_id = :projectId AND memory_id = :memoryId',
      { tenantId: event.tenantId, projectId, memoryId },
    );
    const confidence = Math.min(0.98, Number(provenance[0]?.base_confidence || memory.confidence) + 0.025 * Math.log2(count));
    await db.execute(
      `UPDATE ai_dreaming_memory SET evidence_count = :count, confidence = :confidence WHERE tenant_id = :tenantId AND id = :memoryId`,
      { tenantId: event.tenantId, memoryId, count, confidence },
    );
    if (memory.status === 'superseded') {
      await db.execute("UPDATE ai_dreaming_memory SET status = 'superseded' WHERE tenant_id = :tenantId AND id = :memoryId", { tenantId: event.tenantId, memoryId });
    }
    for (const historical of memory.supersedes || []) {
      // Only exact evidence already persisted for this tenant and project may
      // be superseded. The old row and its source evidence remain auditable.
      const historicalBinds = { tenantId: event.tenantId, projectId, memoryId, sourceId: historical.sourceEventId, evidenceHash: digest(historical.span) };
      const historicalIds = `SELECT memory_id FROM dream_memory_evidence WHERE tenant_id = :tenantId AND project_id = :projectId
        AND source_event_id = :sourceId AND evidence_hash = :evidenceHash AND memory_id <> :memoryId`;
      await db.execute(`UPDATE ai_dreaming_memory SET status = 'superseded' WHERE tenant_id = :tenantId AND id IN (${historicalIds})`, historicalBinds);
      await db.execute(`UPDATE dream_memory_provenance SET superseded_by = :memoryId WHERE tenant_id = :tenantId AND project_id = :projectId AND memory_id IN (${historicalIds})`, historicalBinds);
    }
    if (topic && isExplicitChange(memory, event)) {
      await db.execute(
        `UPDATE ai_dreaming_memory SET status = 'superseded', updated_at = :now
         WHERE tenant_id = :tenantId AND id IN (
           SELECT memory_id FROM dream_memory_provenance WHERE tenant_id = :tenantId AND project_id = :projectId
             AND topic_key = :topic AND occurred_at < :occurredAt AND memory_id <> :memoryId AND certainty <> 'uncertain'
         )`,
        { tenantId: event.tenantId, projectId, memoryId, topic, occurredAt, now: new Date().toISOString() },
      );
      await db.execute(
        `UPDATE dream_memory_provenance SET superseded_by = :memoryId WHERE tenant_id = :tenantId AND project_id = :projectId
         AND topic_key = :topic AND occurred_at < :occurredAt AND memory_id <> :memoryId AND certainty <> 'uncertain'`,
        { tenantId: event.tenantId, projectId, memoryId, topic, occurredAt },
      );
    }
  }

  static async expireProcessedSources(options: { before: string; projectId?: string }): Promise<{ expired: number }> {
    const auth = authStorage.getStore();
    if (!auth) throw new Error('Auth context required for retention');
    if (!Number.isFinite(Date.parse(options.before))) throw new Error('Invalid retention cutoff');
    const cutoffPredicate = process.env.CODEATLAS_DB_TYPE?.toLowerCase() === 'postgres'
      ? 'created_at < :before'
      : 'julianday(created_at) < julianday(:before)';
    const result = await createDatabaseAdapter().execute(
      `UPDATE dream_capture_events SET content_redacted = '[SOURCE_EXPIRED]', checkpoint_json = NULL
       WHERE tenant_id = :tenantId AND status IN ('processed', 'filtered') AND content_redacted <> '[SOURCE_EXPIRED]'
         AND ${cutoffPredicate} ${options.projectId ? 'AND project_id = :projectId' : ''}`,
      { tenantId: auth.uid, before: new Date(options.before).toISOString(), ...(options.projectId ? { projectId: options.projectId } : {}) },
    );
    return { expired: result.rowsAffected };
  }
}
