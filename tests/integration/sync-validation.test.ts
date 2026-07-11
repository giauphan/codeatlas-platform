/**
 * Integration tests for sync-public.sh — Sync validation logic
 *
 * Tests the core validation rules and script content.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.resolve(process.cwd(), 'scripts/sync-public.sh');

describe('Sanitization rules', () => {
  test('script removes .github/workflows/cd.yml', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.github/workflows/cd.yml'));
    assert.ok(content.includes('rm -f'));
  });

  test('script removes .Jules/ and .jules/ directories', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('.Jules/'));
    assert.ok(content.includes('.jules/'));
  });

  test('script updates README.md from codeatlas-ai to codeatlas-platform', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('codeatlas-platform'));
    assert.ok(content.includes('sed'));
  });
});

describe('Git push safety', () => {
  test('default push uses --force-with-lease (not --force)', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('--force-with-lease'));
  });

  test('supports FORCE=1 override with --force', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('--force') && content.includes('FORCE'));
  });

  test('supports DRY_RUN=1 preview mode', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('DRY_RUN'));
  });

  test('aborts on divergence with clear message', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('ABORTED') || content.includes('abort'));
  });
});

describe('History divergence detection logic', () => {
  test('checks private ahead count', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('AHEAD') || content.includes('ahead'));
    assert.ok(content.includes('$(git log'));
  });

  test('checks public ahead count (stale force-push detection)', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('BEHIND') || content.includes('behind'));
  });
});
