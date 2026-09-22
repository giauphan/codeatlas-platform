import { checkNoiseBlocklist } from '../services/noiseBlocklist.js';
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  tier: string;
  uid: string;
  keyId: string;
  email?: string;
  role?: string;
}

export const authStorage = new AsyncLocalStorage<AuthContext>();

/**
 * Compact context by removing noise using existing noise filtering rules.
 * Preserves main context memory and optionally saves additional genome/ADN segments.
 */
export async function compactContext(context: string): Promise<string> {
  const lines = context.split('\n');
  const filteredLines = lines.filter(line => !checkNoiseBlocklist(line).isNoise);
  return filteredLines.join('\n');
}
