/** Opt-in synthetic-corpus evaluation; never reads operator transcripts or a memory database. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, fchmodSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateFixtures, formatEvaluationFailures, type ExtractionFixture } from './memory-extraction-harness.js';
mock.module(new URL('../../src/services/dreamingService.js', import.meta.url).href, { namedExports: { DreamingService: {} } });
mock.module(new URL('../../src/services/genomeService.js', import.meta.url).href, { namedExports: { GenomeService: {} } });
mock.module(new URL('../../src/services/wikiService.js', import.meta.url).href, { namedExports: { WikiService: {} } });
const { createMemoryExtractionGenerator } = await import('../../src/services/llmService.js');
const { extractStructuredMemories, redactMemoryText } = await import('../../src/services/structuredMemoryExtractor.js');

const METRIC_VERSION = 2;
export type ModelQualityCorpus = 'rawrelease' | 'adjudicated' | 'finalunseen';

export function selectModelQualityCorpus(value: string | undefined): ModelQualityCorpus {
  if (value === undefined) return 'adjudicated';
  if (value === 'rawrelease' || value === 'adjudicated' || value === 'finalunseen') return value;
  if (value === 'final-unseen') return 'finalunseen';
  throw new Error(`unsupported CODEATLAS_MEMORY_QUALITY_CORPUS: ${value}`);
}

function fixturesFromPayload(payload: unknown): ExtractionFixture[] {
  if (Array.isArray(payload)) return payload as ExtractionFixture[];
  if (!payload || typeof payload !== 'object') throw new Error('selected memory quality corpus must contain a fixture array');
  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.fixtures)) return value.fixtures as ExtractionFixture[];
  if (Array.isArray(value.cases)) return value.cases as ExtractionFixture[];
  throw new Error('selected memory quality corpus must contain a fixture array');
}

function corpusMetadata(payload: unknown, selected: ModelQualityCorpus): Record<string, unknown> {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  return {
    qualityCorpus: selected,
    ...(typeof value.annotationVersion === 'number' ? { annotationVersion: value.annotationVersion } : {}),
    ...(typeof value.parentSha256 === 'string' ? { parentSha256: value.parentSha256 } : {}),
    ...(typeof value.datasetVersion === 'number' ? { datasetVersion: value.datasetVersion } : {}),
    ...(typeof value.caseCount === 'number' ? { caseCount: value.caseCount } : {}),
    ...(value.splitCounts && typeof value.splitCounts === 'object' && !Array.isArray(value.splitCounts) ? { splitCounts: value.splitCounts } : {}),
  };
}

test('model quality corpus selector is limited and defaults to adjudicated data', () => {
  assert.equal(selectModelQualityCorpus(undefined), 'adjudicated');
  assert.equal(selectModelQualityCorpus('rawrelease'), 'rawrelease');
  assert.equal(selectModelQualityCorpus('adjudicated'), 'adjudicated');
  assert.equal(selectModelQualityCorpus('finalunseen'), 'finalunseen');
  assert.equal(selectModelQualityCorpus('final-unseen'), 'finalunseen');
  assert.throws(() => selectModelQualityCorpus('other'), /unsupported CODEATLAS_MEMORY_QUALITY_CORPUS/);
});

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertSourceEventsUnchanged(adjudicated: ExtractionFixture[], original: ExtractionFixture[]): void {
  assert.equal(adjudicated.length, original.length, 'adjudication must preserve fixture count');
  const originalById = new Map(original.map(fixture => [fixture.id, fixture]));
  assert.equal(originalById.size, original.length, 'raw fixture IDs must be unique');
  assert.equal(new Set(adjudicated.map(fixture => fixture.id)).size, adjudicated.length, 'adjudicated fixture IDs must be unique');
  for (const fixture of adjudicated) {
    const raw = originalById.get(fixture.id);
    assert.ok(raw, `${fixture.id}: adjudicated fixture must exist in the original corpus`);
    const sortEvents = (events: ExtractionFixture['sourceEvents']) => [...events].sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(sortEvents(fixture.sourceEvents), sortEvents(raw.sourceEvents), `${fixture.id}: source events must be identical to the raw fixture`);
  }
}

function redactedSnapshotCandidate(candidate: unknown): Record<string, unknown> {
  const value = candidate as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ['kind', 'memoryType', 'certainty', 'status'] as const) {
    if (typeof value?.[key] === 'string') safe[key] = redactMemoryText(value[key] as string);
  }
  for (const key of ['content', 'text'] as const) {
    if (typeof value?.[key] === 'string') safe[key] = redactMemoryText(value[key] as string);
  }
  if (Array.isArray(value?.evidence)) {
    safe.evidence = value.evidence.map((entry) => {
      const evidence = entry as Record<string, unknown>;
      return {
        ...(typeof evidence?.sourceEventId === 'string' ? { sourceEventId: redactMemoryText(evidence.sourceEventId) } : {}),
        ...(typeof evidence?.span === 'string' ? { span: redactMemoryText(evidence.span) } : {}),
      };
    });
  }
  return safe;
}

function writeCandidateSnapshot(path: string, model: string, sourceHash: string, promptHash: string, candidates: ReadonlyMap<string, unknown>, metadata: Record<string, unknown>): void {
  const snapshot = {
    model,
    sourceHash,
    promptHash,
    corpus: metadata,
    candidates: [...candidates.entries()].map(([fixtureId, values]) => ({
      fixtureId,
      memories: (Array.isArray(values) ? values : []).map(redactedSnapshotCandidate),
    })),
  };
  const descriptor = openSync(path, 'w', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

test('configured checkpoint extraction meets the approved semantic quality and privacy thresholds', {
  skip: process.env.RUN_MODEL_MEMORY_QUALITY !== '1',
}, async () => {
  const generate = createMemoryExtractionGenerator();
  assert.ok(generate, 'Set the explicit extraction endpoint and model to run this opt-in profile');
  const selectedCorpus = selectModelQualityCorpus(process.env.CODEATLAS_MEMORY_QUALITY_CORPUS);
  const selectedPath = {
    rawrelease: '../fixtures/memory-extraction/release-holdout.json',
    adjudicated: '../fixtures/memory-extraction/release-holdout-adjudicated.json',
    finalunseen: '../fixtures/memory-extraction/final-unseen-holdout.json',
  }[selectedCorpus];
  const payload = JSON.parse(readFileSync(new URL(selectedPath, import.meta.url), 'utf8')) as unknown;
  const fixtures = fixturesFromPayload(payload);
  if (selectedCorpus === 'adjudicated') {
    const metadata = payload as Record<string, unknown>;
    assert.equal(typeof metadata.annotationVersion, 'number', 'adjudicated corpus must retain its annotation version');
    assert.equal(typeof metadata.parentSha256, 'string', 'adjudicated corpus must retain its original parent hash');
    const original = JSON.parse(readFileSync(new URL('../fixtures/memory-extraction/release-holdout.json', import.meta.url), 'utf8')) as unknown;
    assertSourceEventsUnchanged(fixtures, fixturesFromPayload(original));
  }
  const selectedMetadata = corpusMetadata(payload, selectedCorpus);
  const sourceHash = hashJson(fixtures.map(fixture => ({
    id: fixture.id,
    sourceEvents: [...fixture.sourceEvents].sort((left, right) => left.id.localeCompare(right.id)),
  })));
  const promptInputs: string[] = [];
  const candidates = new Map<string, Awaited<ReturnType<typeof extractStructuredMemories>>>();
  let index = 0;
  let providerCalls = 0;
  let providerErrors = 0;
  let recoveredRequests = 0;
  await Promise.all(Array.from({ length: 1 }, async () => {
    for (;;) {
      const fixture = fixtures[index++];
      if (!fixture) return;
      const memories = await extractStructuredMemories(fixture.sourceEvents.map(event => ({ ...event })), { checkpoint: true, generate: async prompt => {
        promptInputs.push(prompt);
        for (let attempt = 0; attempt < 2; attempt++) {
          providerCalls++;
          try { const result = await generate(prompt); if (attempt) recoveredRequests++; return result; }
          catch { if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; } }
        }
        providerErrors++; throw new Error('Configured provider unavailable');
      } });
      candidates.set(fixture.id, memories);
    }
  }));
  const summary = await evaluateFixtures(fixtures, async (_transcript, _provider, _project, sessionId) => candidates.get(sessionId) || null);
  const forbidden = summary.outcomes.reduce((sum, item) => sum + item.violations.length, 0);
  const promptHash = hashJson([...new Set(promptInputs)]);
  console.log(JSON.stringify({ profile: 'configured-checkpoint-model', metricVersion: METRIC_VERSION, ...selectedMetadata,
    fixtures: summary.fixtureCount, expected: summary.expectedCount,
    expectedFragmentCount: summary.expectedFragmentCount,
    truePositives: summary.truePositives, falsePositives: summary.falsePositives, falseNegatives: summary.falseNegatives,
    precision: summary.precision, recall: summary.recall, byLocale: summary.byLocale, byKind: summary.byKind,
    groundingViolations: summary.groundingViolations, forbiddenViolations: forbidden, providerCalls, providerErrors, recoveredRequests }));
  const snapshotPath = process.env.CODEATLAS_MODEL_QUALITY_SNAPSHOT;
  if (snapshotPath) {
    writeCandidateSnapshot(
      snapshotPath,
      process.env.CODEATLAS_MEMORY_EXTRACTION_MODEL || 'unspecified',
      sourceHash,
      promptHash,
      candidates,
      selectedMetadata,
    );
  }
  const detail = formatEvaluationFailures(summary);
  assert.equal(providerErrors, 0, 'Provider errors invalidate this model-profile quality measurement');
  assert.ok(summary.precision >= .85, `Model precision below .85\n${detail}`);
  assert.ok(summary.recall >= .75, `Model recall below .75\n${detail}`);
  for (const [locale, value] of Object.entries(summary.byLocale)) assert.ok(value.recall >= .70, `${locale} recall below .70\n${detail}`);
  assert.equal(summary.groundingViolations, 0, `Ungrounded model output\n${detail}`);
  assert.equal(forbidden, 0, `Forbidden content\n${detail}`);
});
