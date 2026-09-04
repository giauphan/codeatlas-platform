import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Global mock for IndexedDB to prevent errors in test environment
if (!globalThis.indexedDB) {
  globalThis.indexedDB = {
    open: vi.fn().mockResolvedValue(null),
    deleteDatabase: vi.fn(),
    cmp: vi.fn(() => 0),
  } as any;
}

if (!globalThis.IDBKeyRange) {
  globalThis.IDBKeyRange = {
    only: vi.fn(),
    lowerBound: vi.fn(),
    upperBound: vi.fn(),
    bound: vi.fn(),
  } as any;
}

// Mock globalThis.location for session storage obfuscation key
if (!globalThis.location) {
  globalThis.location = { origin: 'http://test.codeatlas.local' } as Location;
}