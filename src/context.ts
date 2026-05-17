import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  tier: string;
  uid: string;
  keyId: string;
}

export const authStorage = new AsyncLocalStorage<AuthContext>();
