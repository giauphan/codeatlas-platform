import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DreamDiagnostics } from '../../src/services/dreamDiagnostics.js';

test('diagnostics aggregate capture, reconciliation, retrieval, and scheduler outcomes as numbers', () => {
  const before = DreamDiagnostics.snapshot();
  DreamDiagnostics.recordCaptureReceived();
  DreamDiagnostics.recordCapture('stored');
  DreamDiagnostics.recordCaptureReceived();
  DreamDiagnostics.recordCapture('filtered');
  DreamDiagnostics.recordReconciliation({ processed: 3, filtered: 2, failed: 1, durationMs: 80, lagMs: 500 });
  DreamDiagnostics.recordRetrieval('empty', 0);
  DreamDiagnostics.recordRetrieval('no_match', 0);
  DreamDiagnostics.recordRetrieval('filtered', 0);
  DreamDiagnostics.recordRetrieval('backend_error', 0);
  DreamDiagnostics.recordScheduler('success', 120);
  DreamDiagnostics.recordScheduler('failure', 240);

  const after = DreamDiagnostics.snapshot();
  assert.equal(after.capture_received - before.capture_received, 2);
  assert.equal(after.capture_stored - before.capture_stored, 1);
  assert.equal(after.capture_filtered - before.capture_filtered, 1);
  assert.equal(after.reconciliation_runs - before.reconciliation_runs, 1);
  assert.equal(after.reconciliation_processed - before.reconciliation_processed, 3);
  assert.equal(after.reconciliation_filtered - before.reconciliation_filtered, 2);
  assert.equal(after.reconciliation_failed - before.reconciliation_failed, 1);
  assert.equal(after.reconciliation_events - before.reconciliation_events, 6);
  assert.equal(after.reconciliation_duration_ms_total - before.reconciliation_duration_ms_total, 80);
  assert.equal(after.reconciliation_duration_ms_max, Math.max(before.reconciliation_duration_ms_max, 80));
  assert.equal(after.reconciliation_lag_ms_latest, 500);
  assert.equal(after.reconciliation_lag_ms_max, Math.max(before.reconciliation_lag_ms_max, 500));
  assert.equal(after.retrieval_empty - before.retrieval_empty, 1);
  assert.equal(after.retrieval_no_match - before.retrieval_no_match, 1);
  assert.equal(after.retrieval_filtered - before.retrieval_filtered, 1);
  assert.equal(after.retrieval_error - before.retrieval_error, 1);
  assert.equal(after.scheduler_success - before.scheduler_success, 1);
  assert.equal(after.scheduler_failure - before.scheduler_failure, 1);
  DreamDiagnostics.recordSchedulerLeaseLost(30);
  const afterLeaseLoss = DreamDiagnostics.snapshot();
  assert.equal(afterLeaseLoss.scheduler_failure - after.scheduler_failure, 1);
  assert.equal(afterLeaseLoss.scheduler_lease_lost - after.scheduler_lease_lost, 1);
  assert.equal(afterLeaseLoss.scheduler_duration_ms_total - before.scheduler_duration_ms_total, 390);
  assert.equal(afterLeaseLoss.scheduler_duration_ms_max, Math.max(before.scheduler_duration_ms_max, 240));
  assert.ok(Object.values(after).every(value => typeof value === 'number' && Number.isFinite(value)));
});

test('backend service metrics do not claim that a host injected context', () => {
  const before = DreamDiagnostics.snapshot();
  DreamDiagnostics.recordRetrieval('ok', 1);
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.injected, before.injected);
});
