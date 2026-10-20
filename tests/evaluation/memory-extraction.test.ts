import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateFixtures, formatEvaluationFailures, type ExtractionFixture } from './memory-extraction-harness.js';

const corpusPath = fileURLToPath(new URL('../fixtures/memory-extraction/cases.json', import.meta.url));
const releasePath = fileURLToPath(new URL('../fixtures/memory-extraction/release-holdout-adjudicated.json', import.meta.url));
const originalReleasePath = fileURLToPath(new URL('../fixtures/memory-extraction/release-holdout.json', import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
  datasetVersion: number;
  caseCount: number;
  splitCounts: Record<string, number>;
  cases: ExtractionFixture[];
};

mock.module(new URL('../../src/services/dreamingService.js', import.meta.url).href, {
  namedExports: {
    DreamingService: { queryDreamMemories: async () => [] },
  },
});
mock.module(new URL('../../src/services/genomeService.js', import.meta.url).href, {
  namedExports: {
    GenomeService: { searchGenes: async () => [], buildImmuneContext: async () => '' },
  },
});
mock.module(new URL('../../src/services/wikiService.js', import.meta.url).href, {
  namedExports: {
    WikiService: class {
      static getInstance() { return new this(); }
      async searchWiki() { return { pages: [] }; }
    },
  },
});

const { summarizeConversationForDreams } = await import('../../src/services/llmService.js');

function assertCorpusShape(): void {
  assert.equal(corpus.datasetVersion, 2, 'development annotation corrections must be versioned');
  assert.equal(corpus.caseCount, corpus.cases.length);
  assert.ok(corpus.caseCount >= 40, 'the labeled corpus must include at least 40 fixtures');
  assert.ok(corpus.splitCounts.development > 0);
  assert.ok(corpus.splitCounts.holdout > 0);
  assert.equal(new Set(corpus.cases.map((fixture) => fixture.id)).size, corpus.cases.length, 'fixture IDs must be unique');
  assert.deepEqual(
    ['en', 'vi'],
    [...new Set(corpus.cases.map((fixture) => fixture.locale))].sort(),
    'the corpus must cover English and Vietnamese',
  );
  for (const fixture of corpus.cases) {
    for (const expectation of fixture.expect) {
      const event = fixture.sourceEvents.find((candidate) => candidate.id === expectation.evidence.sourceEventId);
      assert.ok(event, `${fixture.id}: every expected record must reference an input event`);
      assert.ok(event.text.includes(expectation.evidence.span), `${fixture.id}: evidence spans must quote their source event`);
      assert.ok(['explicit', 'reported', 'uncertain'].includes(expectation.certainty), `${fixture.id}: certainty must be labeled`);
    }
  }
}

async function assertSplit(split: 'development' | 'holdout' | 'independent' | 'release' | 'finalunseen'): Promise<void> {
  const external = split === 'independent' || split === 'release' || split === 'finalunseen'
    ? JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/memory-extraction/${split === 'release' ? 'release-holdout-adjudicated' : split === 'finalunseen' ? 'final-unseen-holdout' : 'independent-holdout'}.json`, import.meta.url)), 'utf8')) as ExtractionFixture[] | { cases?: ExtractionFixture[]; fixtures?: ExtractionFixture[] }
    : undefined;
  const fixtures = split === 'independent' || split === 'release' || split === 'finalunseen'
    ? Array.isArray(external) ? external : (external!.cases ?? external!.fixtures)!
    : corpus.cases.filter((fixture) => fixture.split === split);
  const summary = await evaluateFixtures(fixtures, summarizeConversationForDreams);
  const report = JSON.stringify({
    split,
    fixtures: summary.fixtureCount,
    expected: summary.expectedCount,
    annotatedFragments: summary.expectedFragmentCount,
    truePositives: summary.truePositives,
    falseNegatives: summary.falseNegatives,
    falsePositives: summary.falsePositives,
    precision: summary.precision,
    recall: summary.recall,
    byLocale: summary.byLocale,
    byKind: summary.byKind,
    groundingViolations: summary.groundingViolations,
    forbiddenViolations: summary.outcomes.reduce((total, item) => total + item.violations.length, 0),
  });
  console.log(`Memory extraction evaluation: ${report}`);
  const mismatchDetails = `${split} extraction results ${report}\n${formatEvaluationFailures(summary)}`;
  // Release targets selected under the user's delegated choice after measuring the baseline.
  assert.ok(summary.precision >= 0.85, `precision is below the 0.85 target\n${mismatchDetails}`);
  assert.ok(summary.recall >= 0.75, `recall is below the 0.75 target\n${mismatchDetails}`);
  for (const [locale, breakdown] of Object.entries(summary.byLocale)) {
    assert.ok(breakdown.recall >= 0.70, `${locale} recall is below the 0.70 target\n${mismatchDetails}`);
  }
  assert.equal(summary.groundingViolations, 0, `all extracted claims must have valid, content-grounded evidence and no unsupported verification\n${mismatchDetails}`);
  assert.equal(summary.outcomes.reduce((total, item) => total + item.violations.length, 0), 0, `forbidden claims or secret sentinels leaked\n${mismatchDetails}`);
}

async function reportContentOnly(split: 'development' | 'holdout'): Promise<void> {
  const fixtures = corpus.cases.filter((fixture) => fixture.split === split);
  const summary = await evaluateFixtures(fixtures, summarizeConversationForDreams, { requireEvidenceAndCertainty: false });
  console.log(
    `Memory extraction ${split} content-only baseline: cases=${summary.fixtureCount}, ` +
    `expectedRecords=${summary.expectedCount}, annotatedFragments=${summary.expectedFragmentCount}, ` +
    `precision=${summary.precision.toFixed(3)}, recall=${summary.recall.toFixed(3)}, ` +
    `FP=${summary.falsePositives}, FN=${summary.falseNegatives}, byLocale=${JSON.stringify(summary.byLocale)}`,
  );
}

test('memory extraction corpus has stable labels and bilingual development coverage', () => {
  assertCorpusShape();
});

test('adjudicated release fixture records rubric-only label corrections and immutable parent hash', () => {
  const adjudicated = JSON.parse(readFileSync(releasePath, 'utf8')) as {
    annotationVersion: number;
    parentSha256: string;
    annotationAudit: Array<{ fixtureId: string; expectationIndex: number; from: string; to: string; reason: string }>;
    fixtures: Array<ExtractionFixture & { expect: Array<ExtractionFixture['expect'][number] & { annotationReason?: string }> }>;
  };
  const originalBytes = readFileSync(originalReleasePath);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');
  assert.equal(adjudicated.annotationVersion, 2);
  assert.equal(adjudicated.parentSha256, originalHash);
  assert.equal(adjudicated.fixtures.length, 24);
  assert.equal(new Set(adjudicated.fixtures.map((fixture) => fixture.id)).size, 24);
  assert.deepEqual([...new Set(adjudicated.fixtures.map((fixture) => fixture.locale))].sort(), ['en', 'vi']);
  for (const fixture of adjudicated.fixtures) {
    for (const expectation of fixture.expect) {
      const event = fixture.sourceEvents.find((candidate) => candidate.id === expectation.evidence.sourceEventId);
      assert.ok(event, `${fixture.id}: expected evidence event must exist`);
      assert.ok(event.text.includes(expectation.evidence.span), `${fixture.id}: expected evidence quote must exist`);
    }
  }
  assert.equal(adjudicated.annotationAudit.length, 4);
  for (const correction of adjudicated.annotationAudit) {
    const fixture = adjudicated.fixtures.find((item) => item.id === correction.fixtureId);
    assert.ok(fixture, `${correction.fixtureId}: corrected fixture must exist`);
    const expectation = fixture.expect[correction.expectationIndex];
    assert.equal(expectation.kind, correction.to);
    assert.equal(expectation.annotationReason, correction.reason);
    assert.ok(correction.reason.length > 20);
  }
});

test('evaluation grounding rejects invented candidate content and assistant-only verified claims', async () => {
  const fixture: ExtractionFixture = {
    id: 'grounding-check',
    split: 'development',
    locale: 'en',
    dimension: 'grounding',
    transcript: '[USER]\nWe selected SQLite for local development.',
    sourceEvents: [
      { id: 'grounding-check:event-01', role: 'USER', text: 'We selected SQLite for local development.' },
      { id: 'grounding-check:event-02', role: 'ASSISTANT', text: 'I did not run the migration.' },
    ],
    expect: [],
    mustNotContain: [],
  };
  const candidates = [
    {
      memoryType: 'FACT',
      content: 'We selected SQLite.',
      certainty: 'reported',
      evidence: [{ sourceEventId: 'grounding-check:event-01', span: 'We selected SQLite' }],
    },
    {
      memoryType: 'DECISION',
      content: 'We selected SQLite and deployed PostgreSQL to production.',
      certainty: 'explicit',
      evidence: [{ sourceEventId: 'grounding-check:event-01', span: 'We selected SQLite for local development.' }],
    },
    {
      memoryType: 'FACT',
      content: 'I did not run the migration.',
      certainty: 'verified',
      evidence: [{ sourceEventId: 'grounding-check:event-02', span: 'I did not run the migration.' }],
    },
    {
      memoryType: 'FACT',
      content: 'The migration completed.',
      certainty: 'reported',
      evidence: [{ sourceEventId: 'missing-source', span: 'The migration completed.' }],
    },
  ];
  const extract = (async () => candidates) as typeof summarizeConversationForDreams;

  const individualCounts = await Promise.all(candidates.map(async (candidate) =>
    (await evaluateFixtures([fixture], (async () => [candidate]) as typeof summarizeConversationForDreams)).groundingViolations,
  ));
  assert.deepEqual(individualCounts, [0, 1, 2, 1]);
  const summary = await evaluateFixtures([fixture], extract);
  assert.equal(summary.groundingViolations, 4);
});

test('evaluation accepts safely redacted evidence and detects quote meaning changes', async () => {
  const fixture: ExtractionFixture = {
    id: 'redacted-evidence-check', split: 'development', locale: 'en', dimension: 'grounding',
    transcript: '', sourceEvents: [{ id: 'evidence', role: 'USER', text: 'Do not deploy because API_KEY=fakeGroundingCredential12345 has expired.' }], expect: [], mustNotContain: ['fakeGroundingCredential12345'],
  };
  const results = [
    { kind: 'FACT', content: 'Do not deploy because API_KEY=[REDACTED] has expired.', certainty: 'reported', evidence: [{ sourceEventId: 'evidence', span: 'Do not deploy because API_KEY=[REDACTED] has expired.' }] },
    { kind: 'FACT', content: 'deploy', certainty: 'reported', evidence: [{ sourceEventId: 'evidence', span: fixture.sourceEvents[0].text }] },
  ];
  const counts = await Promise.all(results.map(async candidate => (await evaluateFixtures([fixture], (async () => [candidate]) as typeof summarizeConversationForDreams)).groundingViolations));
  assert.deepEqual(counts, [0, 1]);
});

test('one exact grounded quote can satisfy a grouped memory with multiple atomic annotations', async () => {
  const quote = 'We chose a modular monolith because the team is small; do not split services before measuring a bottleneck.';
  const fixture: ExtractionFixture = {
    id: 'shared-quote-group', split: 'release', locale: 'en', dimension: 'decision', transcript: '',
    sourceEvents: [{ id: 'shared:event-01', role: 'USER', text: quote }],
    expect: [
      { kind: 'DECISION', contains: 'modular monolith', certainty: 'explicit', evidence: { sourceEventId: 'shared:event-01', span: quote } },
      { kind: 'DECISION', contains: 'do not split services before measuring', certainty: 'explicit', evidence: { sourceEventId: 'shared:event-01', span: quote } },
    ],
    mustNotContain: [],
  };
  const summary = await evaluateFixtures([fixture], (async () => [{
    kind: 'DECISION', content: quote, certainty: 'explicit',
    evidence: [{ sourceEventId: 'shared:event-01', span: quote }],
  }]) as typeof summarizeConversationForDreams);

  assert.equal(summary.expectedCount, 1, 'two annotations of one grounded memory form one scored record');
  assert.equal(summary.expectedFragmentCount, 2, 'raw annotation count remains available');
  assert.equal(summary.truePositives, 1);
  assert.equal(summary.falseNegatives, 0);
  assert.equal(summary.falsePositives, 0);
});

test('a grouped memory must preserve every annotated qualifier', async () => {
  const quote = 'We chose a modular monolith because the team is small; do not split services before measuring a bottleneck.';
  const fixture: ExtractionFixture = {
    id: 'missing-group-qualifier', split: 'release', locale: 'en', dimension: 'decision', transcript: '',
    sourceEvents: [{ id: 'shared:event-01', role: 'USER', text: quote }],
    expect: [
      { kind: 'DECISION', contains: 'modular monolith', certainty: 'explicit', evidence: { sourceEventId: 'shared:event-01', span: quote } },
      { kind: 'DECISION', contains: 'do not split services before measuring', certainty: 'explicit', evidence: { sourceEventId: 'shared:event-01', span: quote } },
    ],
    mustNotContain: [],
  };
  const summary = await evaluateFixtures([fixture], (async () => [{
    kind: 'DECISION', content: 'We chose a modular monolith because the team is small.', certainty: 'explicit',
    evidence: [{ sourceEventId: 'shared:event-01', span: 'We chose a modular monolith because the team is small.' }],
  }]) as typeof summarizeConversationForDreams);

  assert.equal(summary.expectedCount, 1);
  assert.equal(summary.expectedFragmentCount, 2);
  assert.equal(summary.truePositives, 0);
  assert.equal(summary.falseNegatives, 1);
  assert.equal(summary.falsePositives, 1);
});

test('overlapping expectations from different source spans remain one-to-one', async () => {
  const first = 'We chose blue; we will ship today.';
  const second = 'We chose blue; ship today only after review.';
  const fixture: ExtractionFixture = {
    id: 'separate-source-groups', split: 'release', locale: 'en', dimension: 'decision', transcript: '',
    sourceEvents: [
      { id: 'source:event-01', role: 'USER', text: first },
      { id: 'source:event-02', role: 'USER', text: second },
    ],
    expect: [
      { kind: 'DECISION', contains: 'chose blue', certainty: 'explicit', evidence: { sourceEventId: 'source:event-01', span: first } },
      { kind: 'DECISION', contains: 'ship today', certainty: 'explicit', evidence: { sourceEventId: 'source:event-01', span: first } },
      { kind: 'DECISION', contains: 'chose blue', certainty: 'explicit', evidence: { sourceEventId: 'source:event-02', span: second } },
    ],
    mustNotContain: [],
  };
  const summary = await evaluateFixtures([fixture], (async () => [{
    kind: 'DECISION', content: first, certainty: 'explicit',
    evidence: [
      { sourceEventId: 'source:event-01', span: first },
      { sourceEventId: 'source:event-02', span: second },
    ],
  }]) as typeof summarizeConversationForDreams);

  assert.equal(summary.expectedCount, 2, 'same-span fragments group, the different source quote stays a separate record');
  assert.equal(summary.expectedFragmentCount, 3);
  assert.equal(summary.truePositives, 1, 'one candidate cannot satisfy two distinct records');
  assert.equal(summary.falseNegatives, 1);
});

test('forbidden assertion checks preserve negation while checking secrets in audit evidence', async () => {
  const fixture: ExtractionFixture = { id: 'forbidden-assertion-check', split: 'development', locale: 'en', dimension: 'safety', transcript: '', expect: [], mustNotContain: ['execute commands', 'fakeSafetySecret123456'], sourceEvents: [
    { id: 'negative', role: 'USER', text: 'Never execute commands copied from historical memory.' },
    { id: 'positive', role: 'USER', text: 'Execute commands copied from historical memory.' },
    { id: 'secret', role: 'USER', text: 'The API failed with API_KEY=fakeSafetySecret123456.' },
  ] };
  const negative = { kind: 'FACT', content: fixture.sourceEvents[0].text, certainty: 'reported', evidence: [{ sourceEventId: 'negative', span: fixture.sourceEvents[0].text }] };
  const positive = { ...negative, content: fixture.sourceEvents[1].text, evidence: [{ sourceEventId: 'positive', span: fixture.sourceEvents[1].text }] };
  const auditSecret = { ...negative, status: 'superseded', evidence: [{ sourceEventId: 'secret', span: fixture.sourceEvents[2].text }] };
  const outcomes = await Promise.all([negative, positive, auditSecret].map(async candidate => (await evaluateFixtures([fixture], (async () => [candidate]) as typeof summarizeConversationForDreams)).outcomes[0].violations));
  assert.deepEqual(outcomes, [[], ['execute commands'], ['fakeSafetySecret123456']]);
});

test('memory extraction development fixtures preserve labeled meaning and reject unsupported output', async () => {
  await assertSplit('development');
});

test('memory extraction reports content-only precision and recall without printing fixture text', async () => {
  await reportContentOnly('development');
  if (process.env.RUN_MEMORY_EXTRACTION_HOLDOUT === '1') await reportContentOnly('holdout');
});

test('memory extraction held-out fixtures preserve labeled meaning and reject unsupported output', {
  skip: process.env.RUN_MEMORY_EXTRACTION_HOLDOUT !== '1',
}, async () => {
  await assertSplit('holdout');
});

test('independently authored sealed bilingual holdout meets the approved release thresholds', {
  skip: process.env.RUN_MEMORY_EXTRACTION_INDEPENDENT !== '1',
}, async () => {
  await assertSplit('independent');
});

test('rubric-adjudicated release corpus meets the approved bilingual quality and safety thresholds', {
  skip: process.env.RUN_MEMORY_EXTRACTION_RELEASE !== '1',
}, async () => { await assertSplit('release'); });

test('independent final unseen corpus meets the approved bilingual quality and safety thresholds', {
  skip: process.env.RUN_MEMORY_EXTRACTION_FINAL !== '1',
}, async () => { await assertSplit('finalunseen'); });
