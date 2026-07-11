import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  tier: string;
  uid: string;
  keyId: string;
  email?: string;
  role?: string;
}

export const authStorage = new AsyncLocalStorage<AuthContext>();
