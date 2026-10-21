import { redactMemoryText } from '../../src/services/structuredMemoryExtractor.js';
import type { summarizeConversationForDreams } from '../../src/services/llmService.js';

export interface ExtractionExpectation {
  kind: string;
  contains: string;
  certainty: 'explicit' | 'reported' | 'uncertain';
  evidence: { sourceEventId: string; span: string };
}

export interface SourceEvent {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL';
  text: string;
}

export interface ExtractionFixture {
  id: string;
  split: 'development' | 'holdout';
  locale: 'en' | 'vi';
  dimension: string;
  transcript: string;
  sourceEvents: SourceEvent[];
  expect: ExtractionExpectation[];
  mustNotContain: string[];
}

export interface ExtractionResult {
  memoryType?: string;
  kind?: string;
  content?: string;
  text?: string;
  certainty?: string;
  status?: 'active' | 'superseded';
  evidence?: Array<{ sourceEventId: string; span: string }>;
}

export interface FixtureOutcome {
  id: string;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  violations: string[];
  groundingViolations: number;
}

export interface EvaluationBreakdown {
  fixtureCount: number;
  expectedCount: number;
  expectedFragmentCount: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
}

export interface EvaluationSummary {
  fixtureCount: number;
  expectedCount: number;
  expectedFragmentCount: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  groundingViolations: number;
  byLocale: Record<string, EvaluationBreakdown>;
  byKind: Record<string, EvaluationBreakdown>;
  outcomes: FixtureOutcome[];
}

export interface EvaluationOptions {
  requireEvidenceAndCertainty?: boolean;
}

const KIND_ALIASES: Record<string, string[]> = {
  DECISION: ['DECISION', 'KNOWLEDGE'],
  FACT: ['FACT', 'KNOWLEDGE'],
  MISTAKE: ['MISTAKE'],
  FIX: ['FIX', 'KNOWLEDGE'],
  PREFERENCE: ['PREFERENCE'],
  TASK_STATUS: ['TASK_STATUS', 'SESSION_SUMMARY', 'KNOWLEDGE'],
  OPEN_QUESTION: ['OPEN_QUESTION', 'KNOWLEDGE'],
};

function normalize(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function resultKind(result: ExtractionResult): string {
  return String(result.kind ?? result.memoryType ?? '').toUpperCase();
}

function resultText(result: ExtractionResult): string {
  return String(result.content ?? result.text ?? '');
}

function normalizeQuote(value: string): string {
  return normalize(value).replace(/[.!?]+$/, '');
}

function groundingViolationCount(result: ExtractionResult, fixture: ExtractionFixture): number {
  const evidence = result.evidence ?? [];
  if (evidence.length === 0) return 1;
  let violations = 0;
  if (!['explicit', 'reported', 'uncertain'].includes(String(result.certainty))) violations += 1;
  const sourceEvents = new Map(fixture.sourceEvents.map((event) => [event.id, event]));
  const citedText: string[] = [];
  let hasNonAssistantEvidence = false;
  for (const item of evidence) {
    const event = sourceEvents.get(item.sourceEventId);
    if (!event || !item.span || !redactMemoryText(event.text).includes(item.span)) {
      violations += 1;
      continue;
    }
    citedText.push(item.span);
    if (event.role !== 'ASSISTANT') hasNonAssistantEvidence = true;
  }
  if (citedText.length === 0) return violations > 0 ? violations : 1;

  // Exact quotes retain negation and qualifiers; token subsets can reverse a claim.
  if (!citedText.some(span => normalizeQuote(resultText(result)) === normalizeQuote(span))) violations += 1;
  if (String(result.certainty).toLowerCase() === 'verified' && !hasNonAssistantEvidence) violations += 1;
  return violations;
}

function newBreakdown(): EvaluationBreakdown {
  return { fixtureCount: 0, expectedCount: 0, expectedFragmentCount: 0, truePositives: 0, falseNegatives: 0, falsePositives: 0, precision: 1, recall: 1 };
}

function finalizeBreakdown(value: EvaluationBreakdown): EvaluationBreakdown {
  value.precision = value.truePositives + value.falsePositives === 0 ? 1 : value.truePositives / (value.truePositives + value.falsePositives);
  value.recall = value.expectedCount === 0 ? 1 : value.truePositives / value.expectedCount;
  return value;
}

function matchesExpectation(
  result: ExtractionResult,
  expectations: ExtractionExpectation[],
  requireEvidenceAndCertainty: boolean,
): boolean {
  const expectation = expectations[0];
  const acceptedKinds = KIND_ALIASES[expectation.kind] ?? [expectation.kind];
  const hasEvidence = result.evidence?.some((item) =>
    item.sourceEventId === expectation.evidence.sourceEventId &&
    normalize(item.span).includes(normalize(expectation.evidence.span)) &&
    normalizeQuote(resultText(result)) === normalizeQuote(item.span),
  ) ?? false;
  return acceptedKinds.includes(resultKind(result)) &&
    expectations.every((item) => normalize(resultText(result)).includes(normalize(item.contains))) &&
    (!requireEvidenceAndCertainty || (result.certainty === expectation.certainty && hasEvidence));
}

function groupExpectations(expectations: ExtractionExpectation[]): ExtractionExpectation[][] {
  const groups = new Map<string, ExtractionExpectation[]>();
  for (const expectation of expectations) {
    const key = JSON.stringify([
      expectation.kind,
      expectation.certainty,
      expectation.evidence.sourceEventId,
      expectation.evidence.span,
    ]);
    const group = groups.get(key) ?? [];
    group.push(expectation);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function assertsForbidden(content: string, forbidden: string): boolean {
  const text = normalize(content);
  const phrase = normalize(forbidden);
  for (let index = text.indexOf(phrase); index >= 0; index = text.indexOf(phrase, index + phrase.length)) {
    // A prohibition must not fail for containing the affirmative phrase it forbids.
    // Limit negation to the same clause, so an earlier negative clause cannot mask
    // a later affirmative assertion.
    const preceding = text.slice(0, index).split(/[.!?;,]|\b(?:but|however|therefore|so|nhưng)\b/iu).at(-1) ?? '';
    if (!/(?:\b(?:not|never|cannot|without)\b|không|chưa)[^.!?;,]{0,100}$/iu.test(preceding)) return true;
  }
  return false;
}

function forbiddenViolations(results: ExtractionResult[], fixture: ExtractionFixture): string[] {
  return fixture.mustNotContain.filter(forbidden => {
    const sensitive = /sensitive|secret|credential/i.test(fixture.dimension) || fixture.sourceEvents.some(event =>
      event.text.includes(forbidden) && !redactMemoryText(event.text).includes(forbidden),
    );
    if (sensitive) return normalize(JSON.stringify(results)).includes(normalize(forbidden));
    return results.some(result => result.status !== 'superseded' && assertsForbidden(resultText(result), forbidden));
  });
}

export async function evaluateFixtures(
  fixtures: ExtractionFixture[],
  extract: typeof summarizeConversationForDreams,
  options: EvaluationOptions = {},
): Promise<EvaluationSummary> {
  const outcomes: FixtureOutcome[] = [];
  const byLocale: Record<string, EvaluationBreakdown> = {};
  const byKind: Record<string, EvaluationBreakdown> = {};

  for (const fixture of fixtures) {
    const allResults = (await extract(fixture.transcript, fixture.locale, `fixture-${fixture.id}`, fixture.id) ?? []) as ExtractionResult[];
    const results = allResults.filter(result => result.status !== 'superseded');
    const matched = new Set<number>();
    let truePositives = 0;
    let falseNegatives = 0;
    let falsePositives = 0;
    const expectationGroups = groupExpectations(fixture.expect);
    const locale = byLocale[fixture.locale] ?? (byLocale[fixture.locale] = newBreakdown());
    locale.fixtureCount += 1;
    locale.expectedCount += expectationGroups.length;
    locale.expectedFragmentCount += fixture.expect.length;
    for (const kindName of new Set(expectationGroups.map((group) => group[0].kind))) {
      const kind = byKind[kindName] ?? (byKind[kindName] = newBreakdown());
      kind.fixtureCount += 1;
    }

    for (const group of expectationGroups) {
      const expectation = group[0];
      const kind = byKind[expectation.kind] ?? (byKind[expectation.kind] = newBreakdown());
      kind.expectedCount += 1;
      kind.expectedFragmentCount += group.length;
      const index = results.findIndex((result, i) =>
        !matched.has(i) && matchesExpectation(result, group, options.requireEvidenceAndCertainty !== false),
      );
      if (index < 0) {
        falseNegatives++;
        kind.falseNegatives++;
      }
      else {
        matched.add(index);
        truePositives++;
        kind.truePositives++;
      }
    }

    for (let index = 0; index < results.length; index += 1) {
      if (matched.has(index)) continue;
      falsePositives += 1;
      const kindName = resultKind(results[index]) || 'UNKNOWN';
      const kind = byKind[kindName] ?? (byKind[kindName] = newBreakdown());
      kind.falsePositives += 1;
    }
    locale.truePositives += truePositives;
    locale.falseNegatives += falseNegatives;
    locale.falsePositives += falsePositives;

    const violations = forbiddenViolations(allResults, fixture);
    const groundingViolations = allResults.reduce((sum, result) => sum + groundingViolationCount(result, fixture), 0);

    outcomes.push({
      id: fixture.id,
      truePositives,
      falseNegatives,
      falsePositives,
      violations,
      groundingViolations,
    });
  }

  const truePositives = outcomes.reduce((sum, item) => sum + item.truePositives, 0);
  const falseNegatives = outcomes.reduce((sum, item) => sum + item.falseNegatives, 0);
  const falsePositives = outcomes.reduce((sum, item) => sum + item.falsePositives, 0);
  const expectedCount = truePositives + falseNegatives;
  const expectedFragmentCount = fixtures.reduce((sum, fixture) => sum + fixture.expect.length, 0);
  for (const locale of Object.values(byLocale)) finalizeBreakdown(locale);
  for (const kind of Object.values(byKind)) finalizeBreakdown(kind);

  return {
    fixtureCount: fixtures.length,
    expectedCount,
    expectedFragmentCount,
    truePositives,
    falseNegatives,
    falsePositives,
    precision: truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives),
    recall: expectedCount === 0 ? 1 : truePositives / expectedCount,
    groundingViolations: outcomes.reduce((sum, item) => sum + item.groundingViolations, 0),
    byLocale,
    byKind,
    outcomes,
  };
}

export function formatEvaluationFailures(summary: EvaluationSummary): string {
  return summary.outcomes
    .filter((item) => item.falseNegatives > 0 || item.falsePositives > 0 || item.violations.length > 0 || item.groundingViolations > 0)
    .map((item) => `${item.id}: FN=${item.falseNegatives}, FP=${item.falsePositives}, forbidden=${item.violations.length}, grounding=${item.groundingViolations}`)
    .join('\n');
}
