import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  tier: string;
  /**
   * The unique identifier for the user or tenant.
   * Note: In this system, `uid` definitively represents the tenant identifier.
   */
  uid: string;
  keyId: string;
  email?: string;
  role?: string;
}

export const authStorage = new AsyncLocalStorage<AuthContext>();
