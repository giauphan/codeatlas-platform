import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCron, validateCronExpression, validateTimeZone } from '../../src/utils/cron.js';

test('cron matcher rejects numeric prefixes and invalid ranges instead of parsing their prefixes', () => {
  assert.equal(matchesCron('0garbage 9 * * *', new Date('2026-10-19T09:00:00Z')), false);
  assert.equal(matchesCron('0 9 32 * *', new Date('2026-10-19T09:00:00Z')), false);
});

test('cron supports lists ranges steps and named months and weekdays', () => {
  assert.equal(matchesCron('*/15 9-17 * JAN,OCT MON-FRI', new Date('2026-10-19T09:30:00Z'), 'UTC'), true);
  assert.equal(matchesCron('*/15 9-17 * JAN,OCT MON-FRI', new Date('2026-10-18T09:30:00Z'), 'UTC'), false);
});

test('configured IANA timezone controls schedule matching across the UTC date boundary', () => {
  assert.equal(matchesCron('0 1 20 10 *', new Date('2026-10-19T18:00:00Z'), 'Asia/Jakarta'), true);
  assert.equal(matchesCron('0 1 20 10 *', new Date('2026-10-19T18:00:00Z'), 'UTC'), false);
});

test('restricted day of month and weekday use conventional OR matching', () => {
  assert.equal(matchesCron('0 9 1 * MON', new Date('2026-10-19T09:00:00Z'), 'UTC'), true);
  assert.equal(matchesCron('0 9 1 * MON', new Date('2026-11-01T09:00:00Z'), 'UTC'), true);
  assert.equal(matchesCron('0 9 1 * MON', new Date('2026-10-20T09:00:00Z'), 'UTC'), false);
});

test('day-of-month steps retain Cronie wildcard AND semantics', () => {
  assert.equal(matchesCron('0 9 */2 * MON', new Date('2026-10-19T09:00:00Z'), 'UTC'), true);
  assert.equal(matchesCron('0 9 */2 * MON', new Date('2026-10-26T09:00:00Z'), 'UTC'), false);
  assert.equal(matchesCron('0 9 1-31/2 * MON', new Date('2026-10-26T09:00:00Z'), 'UTC'), true);
});

test('cron and timezone validators reject malformed fields and non-IANA zones', () => {
  assert.equal(validateCronExpression('*/0 9 * * *').valid, false);
  assert.equal(validateCronExpression('0 9 * FOO MON').valid, false);
  assert.equal(validateCronExpression('0 9 * * MON').valid, true);
  assert.equal(validateTimeZone('Mars/Olympus').valid, false);
  assert.equal(validateTimeZone('Asia/Jakarta').valid, true);
  assert.equal(matchesCron('0 9 * * *', new Date('2026-10-19T09:00:00Z'), 'Mars/Olympus'), false);
});
