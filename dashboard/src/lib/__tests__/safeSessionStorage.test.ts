import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { safeSessionStorageGetItem, safeSessionStorageSetItem, safeSessionStorageRemoveItem } from '../safeSessionStorage';

describe('safeSessionStorage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it('should encode and decode sensitive values', () => {
    const key = 'test_key';
    const value = 'sensitive_token_123';
    safeSessionStorageSetItem(key, value);
    const stored = sessionStorage.getItem(key);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(value); // not plaintext
    expect(stored).toMatch(/^v1:/); // encoded prefix
    const retrieved = safeSessionStorageGetItem(key);
    expect(retrieved).toBe(value);
  });

  it('should handle legacy plaintext values (backwards compatibility)', () => {
    const key = 'legacy_key';
    const value = 'plaintext_token';
    sessionStorage.setItem(key, value); // legacy write
    const retrieved = safeSessionStorageGetItem(key);
    expect(retrieved).toBe(value); // unchanged
  });

  it('should return null for missing keys', () => {
    expect(safeSessionStorageGetItem('missing_key')).toBeNull();
  });

  it('should remove items', () => {
    const key = 'to_remove';
    safeSessionStorageSetItem(key, 'value');
    safeSessionStorageRemoveItem(key);
    expect(safeSessionStorageGetItem(key)).toBeNull();
  });

  it('should handle quota errors gracefully', () => {
    const key = 'quota_test';
    const value = 'x'.repeat(10 * 1024 * 1024); // 10 MB
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    safeSessionStorageSetItem(key, value);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds browser sessionStorage quota'));
    consoleSpy.mockRestore();
  });
});