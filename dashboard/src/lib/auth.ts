import { safeSessionStorageGetItem, safeSessionStorageSetItem, safeSessionStorageRemoveItem } from './safeSessionStorage';

const API_KEY_STORAGE_KEY = 'ca_api_key';
const REFRESH_TOKEN_STORAGE_KEY = 'ca_refresh_token';
const USER_EMAIL_STORAGE_KEY = 'ca_user_email';

// Dedup concurrent token refreshes — only one refresh call at a time
let refreshPromise: Promise<boolean> | null = null;

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function isFirebaseToken(token: string): boolean {
  return !token.startsWith('ca_');
}

function isTokenExpired(token: string): boolean {
  if (!isFirebaseToken(token)) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  // Refresh 5 min before actual expiry to avoid race conditions
  return (payload.exp * 1000) - 300_000 < Date.now();
}

/**
 * Refresh Firebase ID token via Firebase REST API (no SDK needed).
 * Returns null if refresh fails (expired refreshToken, network error, etc).
 */
async function refreshFirebaseToken(refreshToken: string): Promise<{ idToken: string; refreshToken: string } | null> {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  if (!apiKey) {
    console.warn('[Auth] No VITE_FIREBASE_API_KEY — cannot refresh token');
    return null;
  }

  try {
    const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[Auth] Token refresh failed (HTTP ${resp.status}): ${body}`);
      return null;
    }

    const data = await resp.json();
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token || refreshToken,
    };
  } catch (err) {
    console.warn('[Auth] Token refresh network error:', err);
    return null;
  }
}

/**
 * Ensure current token is valid, refresh if expired.
 * Returns true if a valid token is available, false if refresh failed.
 */
export async function ensureValidToken(): Promise<boolean> {
  const savedKey = safeSessionStorageGetItem(API_KEY_STORAGE_KEY);
  if (!savedKey) return false;
  if (!isFirebaseToken(savedKey)) return true; // API keys never expire

  if (!isTokenExpired(savedKey)) return true; // still fresh

  // Token expired — try refresh
  const refreshToken = safeSessionStorageGetItem(REFRESH_TOKEN_STORAGE_KEY);
  if (!refreshToken) {
    console.warn('[Auth] Token expired but no refresh token stored');
    return false;
  }

  // Dedup concurrent refresh calls
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const result = await refreshFirebaseToken(refreshToken);
        if (result) {
          safeSessionStorageSetItem(API_KEY_STORAGE_KEY, result.idToken);
          if (result.refreshToken !== refreshToken) {
            safeSessionStorageSetItem(REFRESH_TOKEN_STORAGE_KEY, result.refreshToken);
          }
          console.log('[Auth] Token refreshed successfully');
          return true;
        }
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

/** Store auth tokens after sign-in */
export function storeAuthTokens(idToken: string, refreshToken?: string): void {
  safeSessionStorageSetItem(API_KEY_STORAGE_KEY, idToken);
  if (refreshToken) {
    safeSessionStorageSetItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
  }
}

/** Clear all auth tokens and redirect to login */
export function logOut(): void {
  safeSessionStorageRemoveItem(API_KEY_STORAGE_KEY);
  safeSessionStorageRemoveItem(REFRESH_TOKEN_STORAGE_KEY);
  safeSessionStorageRemoveItem(USER_EMAIL_STORAGE_KEY);
  window.location.reload();
}

/**
 * Build auth headers — auto-refreshes expired Firebase ID tokens.
 * When refresh fails, clears session and reloads (shows Auth component).
 */
export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const savedApiKey = safeSessionStorageGetItem(API_KEY_STORAGE_KEY);
  if (!savedApiKey) {
    return { 'Content-Type': 'application/json' };
  }

  if (isFirebaseToken(savedApiKey)) {
    const valid = await ensureValidToken();
    if (!valid) {
      // Can't refresh — redirect to login
      console.warn('[Auth] Token refresh failed, clearing session');
      logOut();
      return { 'Content-Type': 'application/json' };
    }
  }

  // Re-read token after possible refresh
  const currentKey = safeSessionStorageGetItem(API_KEY_STORAGE_KEY) || savedApiKey;

  if (currentKey.startsWith('ca_')) {
    return { 'x-api-key': currentKey, 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${currentKey}`, 'Content-Type': 'application/json' };
};

/**
 * Convenience fetch wrapper — auto-refreshes token, attaches auth headers.
 */
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = await getAuthHeaders();
  return fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string> || {}) },
  });
}
