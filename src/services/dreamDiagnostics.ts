export interface DreamDiagnosticCounters {
  stored: number;
  filtered: number;
  duplicate: number;
  failed: number;
  queried: number;
  retrieved: number;
  injected: number;
  cron: number;
  events_stored: number;
  events_duplicate: number;
  events_filtered: number;
  events_failed: number;
  capture_received: number;
  capture_stored: number;
  capture_filtered: number;
  capture_duplicate: number;
  capture_failed: number;
  reconciliation_runs: number;
  reconciliation_processed: number;
  reconciliation_filtered: number;
  reconciliation_failed: number;
  reconciliation_events: number;
  reconciliation_duration_ms_total: number;
  reconciliation_duration_ms_max: number;
  reconciliation_lag_ms_latest: number;
  reconciliation_lag_ms_max: number;
  retrieval_empty: number;
  retrieval_no_match: number;
  retrieval_filtered: number;
  retrieval_error: number;
  scheduler_success: number;
  scheduler_failure: number;
  scheduler_lease_lost: number;
  scheduler_duration_ms_total: number;
  scheduler_duration_ms_max: number;
}

const counters: DreamDiagnosticCounters = {
  stored: 0, filtered: 0, duplicate: 0, failed: 0, queried: 0, retrieved: 0,
  injected: 0, cron: 0, events_stored: 0, events_duplicate: 0, events_filtered: 0,
  events_failed: 0, capture_received: 0, capture_stored: 0, capture_filtered: 0,
  capture_duplicate: 0, capture_failed: 0, reconciliation_runs: 0,
  reconciliation_processed: 0, reconciliation_filtered: 0, reconciliation_failed: 0,
  reconciliation_events: 0, reconciliation_duration_ms_total: 0,
  reconciliation_duration_ms_max: 0, reconciliation_lag_ms_latest: 0,
  reconciliation_lag_ms_max: 0, retrieval_empty: 0, retrieval_no_match: 0,
  retrieval_filtered: 0, retrieval_error: 0,
  scheduler_success: 0, scheduler_failure: 0, scheduler_lease_lost: 0, scheduler_duration_ms_total: 0,
  scheduler_duration_ms_max: 0,
};

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export const DreamDiagnostics = {
  snapshot(): DreamDiagnosticCounters {
    return { ...counters };
  },

  recordSave(status: "stored" | "duplicate" | "filtered" | "rejected" | "error"): void {
    if (status === "stored" || status === "duplicate" || status === "filtered") counters[status] += 1;
    else counters.failed += 1;
  },

  recordQuery(retrieved: number): void {
    counters.queried += 1;
    counters.retrieved += Math.max(0, Math.floor(retrieved));
  },

  recordRetrieval(status: string, retrieved: number): void {
    this.recordQuery(retrieved);
    if (status === 'empty') counters.retrieval_empty += 1;
    else if (status === 'no_match') counters.retrieval_no_match += 1;
    else if (status === 'filtered') counters.retrieval_filtered += 1;
    else if (/_error$/.test(status)) counters.retrieval_error += 1;
  },

  recordFailure(): void {
    counters.failed += 1;
  },

  // Legacy field retained for API compatibility. Host adapters own actual
  // injection reporting; backend retrieval never calls this method.
  recordInjected(count: number): void {
    counters.injected += Math.max(0, Math.floor(count));
  },

  recordCron(): void {
    counters.cron += 1;
  },

  recordCaptureReceived(): void {
    counters.capture_received += 1;
  },

  recordCapture(status: "stored" | "duplicate" | "filtered" | "rejected" | "error"): void {
    if (status === "stored") { counters.events_stored += 1; counters.capture_stored += 1; }
    else if (status === "duplicate") { counters.events_duplicate += 1; counters.capture_duplicate += 1; }
    else if (status === "filtered") { counters.events_filtered += 1; counters.capture_filtered += 1; }
    else { counters.events_failed += 1; counters.capture_failed += 1; }
  },

  recordReconciliation(result: { processed: number; filtered: number; failed: number; durationMs: number; lagMs: number }): void {
    const processed = Math.floor(nonNegative(result.processed));
    const filtered = Math.floor(nonNegative(result.filtered));
    const failed = Math.floor(nonNegative(result.failed));
    const durationMs = nonNegative(result.durationMs);
    const lagMs = nonNegative(result.lagMs);
    counters.reconciliation_runs += 1;
    counters.reconciliation_processed += processed;
    counters.reconciliation_filtered += filtered;
    counters.reconciliation_failed += failed;
    counters.reconciliation_events += processed + filtered + failed;
    counters.reconciliation_duration_ms_total += durationMs;
    counters.reconciliation_duration_ms_max = Math.max(counters.reconciliation_duration_ms_max, durationMs);
    counters.reconciliation_lag_ms_latest = lagMs;
    counters.reconciliation_lag_ms_max = Math.max(counters.reconciliation_lag_ms_max, lagMs);
  },

  recordScheduler(outcome: 'success' | 'failure', durationMs: number): void {
    const duration = nonNegative(durationMs);
    if (outcome === 'success') counters.scheduler_success += 1;
    else counters.scheduler_failure += 1;
    counters.scheduler_duration_ms_total += duration;
    counters.scheduler_duration_ms_max = Math.max(counters.scheduler_duration_ms_max, duration);
  },

  recordSchedulerLeaseLost(durationMs: number): void {
    const duration = nonNegative(durationMs);
    counters.scheduler_failure += 1;
    counters.scheduler_lease_lost += 1;
    counters.scheduler_duration_ms_total += duration;
    counters.scheduler_duration_ms_max = Math.max(counters.scheduler_duration_ms_max, duration);
  },
};
