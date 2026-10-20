import { createHash, randomUUID } from "node:crypto";
import type { IDatabaseAdapter } from "../database/adapters/interface.js";
import { logger } from "../utils/logger.js";
import { DreamDiagnostics } from "./dreamDiagnostics.js";
import { matchesCron, validateTimeZone } from "../utils/cron.js";

export type DreamJobType = "reconciliation" | "consolidation";
export type DreamRunState = "running" | "retryable" | "completed" | "failed";

export interface ClaimRunInput {
  jobType: DreamJobType;
  tenantId: string;
  project?: string;
  scheduledFor: string;
  timezone: string;
  ownerId: string;
  now: string;
  leaseMs: number;
  maxAttempts: number;
}

export interface DreamRunClaim {
  jobKey: string;
  runId: string;
  jobType: DreamJobType;
  tenantId: string;
  project: string;
  scheduledFor: string;
  timezone: string;
  ownerId: string;
  ownerToken: string;
  fencingToken: number;
  attempt: number;
  leaseUntil: string;
}

export interface DreamJobRun {
  jobKey: string;
  runId: string;
  jobType: DreamJobType;
  tenantId: string;
  project: string;
  scheduledFor: string;
  timezone: string;
  state: DreamRunState;
  ownerId: string | null;
  fencingToken: number;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  operationStats: Record<string, number>;
  errorReason: string | null;
  leaseUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DreamJobResult {
  success: boolean;
  counts?: Record<string, number>;
}

interface RawRun {
  job_key: string;
  run_id: string;
  job_type: DreamJobType;
  tenant_id: string;
  project: string;
  scheduled_for_utc: string | Date;
  timezone: string;
  state: DreamRunState;
  owner_id: string | null;
  owner_token: string | null;
  fencing_token: number;
  lease_until: string | Date | null;
  attempt: number;
  max_attempts: number;
  next_attempt_at: string | Date | null;
  operation_stats: string | Record<string, number> | null;
  error_reason: string | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
}

function asIso(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function decodeStats(value: RawRun["operation_stats"]): Record<string, number> {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  } catch {
    return {};
  }
}

function mapRun(row: RawRun): DreamJobRun {
  return {
    jobKey: row.job_key,
    runId: row.run_id,
    jobType: row.job_type,
    tenantId: row.tenant_id,
    project: row.project,
    scheduledFor: asIso(row.scheduled_for_utc)!,
    timezone: row.timezone,
    state: row.state,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: asIso(row.next_attempt_at),
    operationStats: decodeStats(row.operation_stats),
    errorReason: row.error_reason,
    leaseUntil: asIso(row.lease_until),
    startedAt: asIso(row.started_at),
    finishedAt: asIso(row.finished_at),
  };
}

function stableJobKey(input: Pick<ClaimRunInput, "jobType" | "tenantId" | "project" | "scheduledFor">): string {
  const canonicalSlot = new Date(input.scheduledFor).toISOString();
  const identity = JSON.stringify([input.jobType, input.tenantId, input.project || "", canonicalSlot]);
  return createHash("sha256").update(identity).digest("hex");
}

function safeStats(result: DreamJobResult | Record<string, number>): string {
  const source = "counts" in result ? result.counts || {} : result;
  const counts = Object.fromEntries(
    Object.entries(source)
      .filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && typeof value === "number" && Number.isFinite(value))
      .slice(0, 32),
  );
  return JSON.stringify(counts);
}

function safeError(reason: string): string {
  return reason
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|x-api-key[=: ]+\S+)/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

/** Durable, cross-instance run claims with lease tokens that fence stale workers. */
export class DreamRunLedger {
  constructor(private readonly db: IDatabaseAdapter) {}

  async tenantScopes(auth: { uid: string; tier: string; role?: string }, selectedTenantId?: string): Promise<string[]> {
    if (selectedTenantId !== undefined) {
      if (!selectedTenantId.trim()) throw new Error("A selected tenant ID must not be empty");
      return [selectedTenantId.trim()];
    }
    if (auth.uid !== 'admin' && auth.tier !== 'admin' && auth.role !== 'admin') return [auth.uid];
    const rows = await this.db.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM dream_capture_events UNION SELECT DISTINCT tenant_id FROM ai_dreaming_memory');
    return [...new Set([auth.uid, ...rows.map(row => row.tenant_id)])].sort();
  }

  async claimRun(input: ClaimRunInput): Promise<DreamRunClaim | null> {
    if (!input.tenantId.trim()) throw new Error("A tenant ID is required for scheduled work");
    if (!input.ownerId.trim()) throw new Error("A worker ID is required for scheduled work");
    if (input.jobType !== "reconciliation" && input.jobType !== "consolidation") throw new Error("Unknown scheduled job type");
    if (!Number.isFinite(Date.parse(input.scheduledFor)) || !Number.isFinite(Date.parse(input.now))) throw new Error("Scheduled time and claim time must be valid ISO dates");
    if (!validateTimeZone(input.timezone).valid) throw new Error("A valid IANA timezone is required");
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1000) throw new Error("Lease must be at least one second");
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10) throw new Error("maxAttempts must be between one and ten");
    const project = input.project || "";
    const jobKey = stableJobKey({ ...input, project });
    const ownerToken = randomUUID();
    const runId = randomUUID();
    const now = new Date(input.now).toISOString();
    const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();

    let rows = await this.db.query<RawRun>(
      `INSERT INTO dream_job_runs (
         job_key, run_id, job_type, tenant_id, project, scheduled_for_utc, timezone,
         state, owner_id, owner_token, fencing_token, lease_until, attempt, max_attempts,
         next_attempt_at, created_at, updated_at, started_at
       ) VALUES (
         :jobKey, :runId, :jobType, :tenantId, :project, :scheduledFor, :timezone,
         'running', :ownerId, :ownerToken, 1, :leaseUntil, 1, :maxAttempts,
         NULL, :now, :now, :now
       )
       -- The table intentionally has both a stable job_key primary key and a
       -- legacy slot unique index. During a concurrent first claim PostgreSQL
       -- can report the slot-index conflict before the targeted job_key arbiter.
       -- Ignore only uniqueness conflicts, then let the conditional UPDATE below
       -- decide atomically whether this caller may own/reclaim the slot.
       ON CONFLICT DO NOTHING
       RETURNING *`,
      { jobKey, runId, jobType: input.jobType, tenantId: input.tenantId, project, scheduledFor: nowDate(input.scheduledFor), timezone: input.timezone, ownerId: input.ownerId, ownerToken, leaseUntil, maxAttempts: input.maxAttempts, now },
    );

    if (rows.length === 0) {
      rows = await this.db.query<RawRun>(
        `UPDATE dream_job_runs SET
           state = 'running', owner_id = :ownerId, owner_token = :ownerToken,
           fencing_token = dream_job_runs.fencing_token + 1,
           lease_until = :leaseUntil,
           attempt = dream_job_runs.attempt + 1,
           max_attempts = :maxAttempts,
           next_attempt_at = NULL, error_reason = NULL,
           updated_at = :now, started_at = :now, finished_at = NULL
         WHERE job_key = :jobKey
           AND state NOT IN ('completed', 'failed')
           AND (state <> 'running' OR lease_until <= :now)
           AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
           AND attempt < :maxAttempts
         RETURNING *`,
        { jobKey, ownerId: input.ownerId, ownerToken, leaseUntil, maxAttempts: input.maxAttempts, now },
      );
    }

    const row = rows[0];
    if (!row) {
      await this.db.execute(
        `UPDATE dream_job_runs SET state = 'failed', owner_id = NULL, owner_token = NULL,
           lease_until = NULL, error_reason = 'retry limit exhausted after lease expiry',
           updated_at = :now, finished_at = :now
         WHERE job_key = :jobKey AND state = 'running' AND lease_until <= :now
           AND attempt >= max_attempts`,
        { jobKey, now },
      );
      return null;
    }
    return {
      jobKey,
      runId: row.run_id,
      jobType: row.job_type,
      tenantId: row.tenant_id,
      project: row.project,
      scheduledFor: asIso(row.scheduled_for_utc)!,
      timezone: row.timezone,
      ownerId: row.owner_id!,
      ownerToken: row.owner_token!,
      fencingToken: Number(row.fencing_token),
      attempt: Number(row.attempt),
      leaseUntil: asIso(row.lease_until)!,
    };
  }

  async heartbeat(claim: DreamRunClaim, now: string, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) return false;
    const instant = new Date(now).toISOString();
    const newExpiry = new Date(Date.parse(instant) + leaseMs).toISOString();
    const result = await this.db.execute(
      `UPDATE dream_job_runs SET lease_until = :newExpiry, updated_at = :now
       WHERE job_key = :jobKey AND owner_token = :ownerToken AND fencing_token = :fencingToken
         AND state = 'running' AND lease_until > :now`,
      { jobKey: claim.jobKey, ownerToken: claim.ownerToken, fencingToken: claim.fencingToken, newExpiry, now: instant },
    );
    return result.rowsAffected === 1;
  }

  async isClaimCurrent(claim: Pick<DreamRunClaim, "jobKey" | "ownerToken" | "fencingToken">, now: string): Promise<boolean> {
    const rows = await this.db.query<{ current: number }>(
      `SELECT 1 AS current FROM dream_job_runs
       WHERE job_key = :jobKey AND owner_token = :ownerToken AND fencing_token = :fencingToken
         AND state = 'running' AND lease_until > :now`,
      { jobKey: claim.jobKey, ownerToken: claim.ownerToken, fencingToken: claim.fencingToken, now: new Date(now).toISOString() },
    );
    return rows.length === 1;
  }

  async completeRun(claim: DreamRunClaim, result: DreamJobResult, now: string): Promise<boolean> {
    if (result.success !== true) return false;
    const instant = new Date(now).toISOString();
    const update = await this.db.execute(
      `UPDATE dream_job_runs SET state = 'completed', operation_stats = :stats,
         error_reason = NULL, owner_id = NULL, owner_token = NULL, lease_until = NULL,
         next_attempt_at = NULL, updated_at = :now, finished_at = :now
       WHERE job_key = :jobKey AND owner_token = :ownerToken AND fencing_token = :fencingToken
         AND state = 'running' AND lease_until > :now`,
      { jobKey: claim.jobKey, ownerToken: claim.ownerToken, fencingToken: claim.fencingToken, stats: safeStats(result), now: instant },
    );
    return update.rowsAffected === 1;
  }

  async failRun(claim: DreamRunClaim, reason: string, now: string, retryAt: string, counts?: Record<string, number>): Promise<boolean> {
    const instant = new Date(now).toISOString();
    const current = await this.getRun(claim.jobKey);
    if (!current) return false;
    const exhausted = claim.attempt >= current.maxAttempts;
    const state: DreamRunState = exhausted ? "failed" : "retryable";
    const update = await this.db.execute(
      `UPDATE dream_job_runs SET state = :state, error_reason = :reason,
         owner_id = NULL, owner_token = NULL, lease_until = NULL,
         next_attempt_at = :nextAttemptAt, operation_stats = COALESCE(:stats, operation_stats), updated_at = :now,
         finished_at = CASE WHEN :state = 'failed' THEN :now ELSE NULL END
       WHERE job_key = :jobKey AND owner_token = :ownerToken AND fencing_token = :fencingToken
         AND state = 'running' AND lease_until > :now`,
      { jobKey: claim.jobKey, ownerToken: claim.ownerToken, fencingToken: claim.fencingToken, state, reason: safeError(reason), nextAttemptAt: exhausted ? null : new Date(retryAt).toISOString(), stats: counts ? safeStats(counts) : null, now: instant },
    );
    return update.rowsAffected === 1;
  }

  async getRun(jobKey: string): Promise<DreamJobRun | null> {
    const rows = await this.db.query<RawRun>(`SELECT * FROM dream_job_runs WHERE job_key = :jobKey`, { jobKey });
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listDueRuns(tenantId: string, now: string, limit = 50): Promise<DreamJobRun[]> {
    const rows = await this.db.query<RawRun>(
      `SELECT * FROM dream_job_runs
       WHERE tenant_id = :tenantId AND (
         (state = 'retryable' AND next_attempt_at <= :now)
         OR (state = 'running' AND lease_until <= :now AND attempt < max_attempts)
       )
       ORDER BY scheduled_for_utc ASC LIMIT :limit`,
      { tenantId, now: new Date(now).toISOString(), limit: Math.max(1, Math.min(500, Math.floor(limit))) },
    );
    return rows.map(mapRun);
  }
}

function nowDate(value: string): string {
  return new Date(value).toISOString();
}

export interface DreamSchedulerOptions {
  ledger: DreamRunLedger;
  ownerId: string;
  executeJob: (claim: DreamRunClaim, signal: AbortSignal) => Promise<{ httpStatus: number; body: unknown }>;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface ScheduledJobSettings {
  dreams_enabled: boolean;
  dreams_schedule: string;
  reconciliation_enabled: boolean;
  reconciliation_schedule: string;
  timezone: string;
  tenant_id: string;
  project_id?: string;
  project?: string;
}

/** Finds the newest scheduled UTC minute in the bounded recovery window. */
export function latestDueCronSlot(expression: string, now: Date, timezone: string, recoveryWindowMinutes = 24 * 60): string | null {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(recoveryWindowMinutes) || recoveryWindowMinutes < 1) return null;
  const latestMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let offset = 0; offset <= recoveryWindowMinutes; offset++) {
    const slot = new Date(latestMinute - offset * 60_000);
    if (matchesCron(expression, slot, timezone)) return slot.toISOString();
  }
  return null;
}

/** Runs due jobs through the internal API and commits only semantic application success. */
export class DreamScheduler {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: DreamSchedulerOptions) {
    this.now = options.now || (() => new Date());
    this.leaseMs = options.leaseMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60_000;
  }

  async runSlot(input: {
    jobType: DreamJobType;
    tenantId: string;
    project?: string;
    scheduledFor: string;
    timezone: string;
  }): Promise<DreamRunState | "skipped"> {
    const claimedAt = this.now();
    const claim = await this.options.ledger.claimRun({
      ...input,
      ownerId: this.options.ownerId,
      now: claimedAt.toISOString(),
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts,
    });
    if (!claim) return "skipped";
    const attemptStartedAt = Date.now();

    const heartbeatMs = this.options.heartbeatMs ?? Math.max(1000, Math.floor(this.leaseMs / 3));
    let heartbeatStopped = false;
    let heartbeatLost = false;
    const controller = new AbortController();
    let failureStats: Record<string, number> | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const renew = async (): Promise<void> => {
      if (heartbeatStopped) return;
      try {
        const renewed = await this.options.ledger.heartbeat(claim, this.now().toISOString(), this.leaseMs);
        if (!renewed) {
          heartbeatLost = true;
          controller.abort(new Error("scheduler lease lost"));
          return;
        }
      } catch (error) {
        logger.warn("[DreamScheduler] Lease heartbeat failed", error instanceof Error ? error.message : String(error));
        heartbeatLost = true;
        controller.abort(new Error("scheduler lease heartbeat failed"));
        return;
      }
      heartbeatTimer = setTimeout(() => void renew(), heartbeatMs);
      heartbeatTimer.unref?.();
    };
    heartbeatTimer = setTimeout(() => void renew(), heartbeatMs);
    heartbeatTimer.unref?.();

    try {
      const response = await this.options.executeJob(claim, controller.signal);
      if (heartbeatLost) throw new Error("scheduler lease was lost while job was running");
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      failureStats = extractOperationStats(body);
      if (!Number.isInteger(response.httpStatus) || response.httpStatus < 200 || response.httpStatus >= 300) {
        throw new Error(`job API returned HTTP ${response.httpStatus}`);
      }
      if (body.success !== true) {
        throw new Error("job API response did not report success=true");
      }
      if ((failureStats.failed ?? 0) > 0) {
        throw new Error("job API response reported failed operations");
      }
      const consolidation = body.consolidation && typeof body.consolidation === "object"
        ? body.consolidation as Record<string, unknown>
        : undefined;
      if (consolidation && (consolidation.status !== "completed" || (Array.isArray(consolidation.errors) && consolidation.errors.length > 0))) {
        throw new Error("consolidation report contains failed operations");
      }
      const result: DreamJobResult = {
        success: true,
        counts: extractOperationStats(body),
      };
      const completed = await this.options.ledger.completeRun(claim, result, this.now().toISOString());
      if (completed) DreamDiagnostics.recordScheduler('success', Date.now() - attemptStartedAt);
      else DreamDiagnostics.recordSchedulerLeaseLost(Date.now() - attemptStartedAt);
      return completed ? "completed" : "skipped";
    } catch (error) {
      if (heartbeatLost) {
        DreamDiagnostics.recordSchedulerLeaseLost(Date.now() - attemptStartedAt);
        return "skipped";
      }
      const attempt = claim.attempt;
      const backoff = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
      const retryAt = new Date(this.now().getTime() + backoff).toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      const recorded = await this.options.ledger.failRun(claim, reason, this.now().toISOString(), retryAt, failureStats);
      if (!recorded) {
        DreamDiagnostics.recordSchedulerLeaseLost(Date.now() - attemptStartedAt);
        return "skipped";
      }
      DreamDiagnostics.recordScheduler('failure', Date.now() - attemptStartedAt);
      return attempt >= this.maxAttempts ? "failed" : "retryable";
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
  }

  async tick(settings: ScheduledJobSettings, now = this.now(), recoveryWindowMinutes = 24 * 60): Promise<Array<{ jobType: DreamJobType; scheduledFor: string; state: DreamRunState | "skipped" }>> {
    const output: Array<{ jobType: DreamJobType; scheduledFor: string; state: DreamRunState | "skipped" }> = [];
    const enabledTypes = new Set<DreamJobType>();
    if (settings.reconciliation_enabled) enabledTypes.add("reconciliation");
    if (settings.dreams_enabled) enabledTypes.add("consolidation");
    const dueRuns = (await this.options.ledger.listDueRuns(settings.tenant_id, now.toISOString()))
      .filter((run) => enabledTypes.has(run.jobType))
      .filter((run) => (!settings.project_id && !settings.project) || run.project === settings.project_id || run.project === settings.project);
    for (const run of dueRuns) {
      output.push({
        jobType: run.jobType,
        scheduledFor: run.scheduledFor,
        state: await this.runSlot({ jobType: run.jobType, tenantId: run.tenantId, project: run.project || undefined, scheduledFor: run.scheduledFor, timezone: run.timezone }),
      });
    }

    const jobs: Array<{ jobType: DreamJobType; enabled: boolean; schedule: string }> = [
      { jobType: "reconciliation", enabled: settings.reconciliation_enabled, schedule: settings.reconciliation_schedule },
      { jobType: "consolidation", enabled: settings.dreams_enabled, schedule: settings.dreams_schedule },
    ];
    for (const job of jobs) {
      if (!job.enabled) continue;
      const scheduledFor = latestDueCronSlot(job.schedule, now, settings.timezone, recoveryWindowMinutes);
      if (!scheduledFor) continue;
      output.push({
        jobType: job.jobType,
        scheduledFor,
        state: await this.runSlot({ jobType: job.jobType, tenantId: settings.tenant_id, project: settings.project_id || settings.project, scheduledFor, timezone: settings.timezone }),
      });
    }
    return output;
  }
}

function extractOperationStats(body: Record<string, unknown>): Record<string, number> {
  const allowed = new Set([
    "pending", "processed", "stored", "filtered", "failed", "dreamsProcessed", "dreamsMerged",
    "conceptsCreated", "dreamsArchived", "dreamsSuperseded", "durationMs",
  ]);
  const result: Record<string, number> = {};
  const add = (source: unknown) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    for (const [key, value] of Object.entries(source)) {
      if (allowed.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
  };
  add(body.counts);
  add(body);
  add(body.consolidation);
  return result;
}
