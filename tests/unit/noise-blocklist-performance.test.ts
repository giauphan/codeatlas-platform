import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoiseBlocklist } from '../../src/services/noiseBlocklist.js';

test('repeated-content detection handles long whitespace without backtracking', () => {
  const value = `same input${' '.repeat(60_000)}unrelated`;
  const start = performance.now();
  assert.equal(checkNoiseBlocklist(value).isNoise, false);
  assert.ok(performance.now() - start < 1_000, 'noise checks must remain linear');
});

test('repeated-content detection retains supported phrases', () => {
  for (const value of ['same input repeated multiple times', 'same input foo repeated multiple times', 'same day-day xyzrepeated multiple times']) {
    assert.match(checkNoiseBlocklist(value).reason ?? '', /degenerate repeated content/);
  }
});

test('scheduler retry detection handles repeated markers without backtracking', () => {
  const start = performance.now();
  assert.equal(checkNoiseBlocklist('stuck '.repeat(15_000) + 'unrelated').isNoise, false);
  assert.ok(performance.now() - start < 1_000, 'scheduler detection must remain linear');
});

test('scheduler retry detection accepts same-line and whitespace-separated markers', () => {
  for (const value of ['stuck while scheduling', 'stuck \n scheduling', 'prefix stuck scheduling suffix']) {
    assert.match(checkNoiseBlocklist(value).reason ?? '', /scheduler retry/);
  }
  assert.equal(checkNoiseBlocklist('stuck task\nscheduling').isNoise, false);
});

test('scheduler detection preserves regex matches across line and word boundaries', () => {
  const parts = ['stuck', 'scheduling', ' ', '\n', '\r', 'x', '_', '-', '\u2028'];
  for (const first of parts) for (const second of parts) for (const third of parts) for (const fourth of parts) {
    const input = first + second + third + fourth;
    const expected = /\bstuck\s+.*\bscheduling\b/i.test(input.trim().toLowerCase());
    assert.equal(checkNoiseBlocklist(input).reason?.includes('scheduler retry') ?? false, expected, JSON.stringify(input));
  }
});
