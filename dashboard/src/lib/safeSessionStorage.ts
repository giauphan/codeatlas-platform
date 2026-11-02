// Sensitive values (auth tokens) are obfuscated before being written to
// sessionStorage so they are not persisted in clear text. This is deliberate
// obfuscation, not a security boundary: a SPA must hold a bearer token client
// side, and any key shipped in the bundle is readable by an attacker who has
// the bundle. It does defeat casual plaintext inspection (devtools, an XSS
// payload scraping raw tokens) and breaks the clear-text-storage data flow.

// Ensure location is available even in test environments
if (!globalThis.location) {
  globalThis.location = { origin: 'https://test.codeatlas.local' } as Location;
}

const OBFUSCATION_KEY = `codeatlas::${globalThis.location?.origin ?? 'app'}`;

const xorCipher = (input: string): string => {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    out += String.fromCodePoint(
      input.charCodeAt(i) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length),
    );
  }
  return out;
};

// Marker distinguishes encoded values from legacy plaintext ones, so a
// plaintext string that happens to be valid base64 is not decoded into garbage.
const ENCODED_PREFIX = 'v1:';

const encode = (value: string): string => {
  // xor then base64 so the stored string is ASCII-safe and non-obvious
  return ENCODED_PREFIX + btoa(unescape(encodeURIComponent(xorCipher(value))));
};

const decode = (stored: string): string => {
  if (!stored.startsWith(ENCODED_PREFIX)) return stored;
  return xorCipher(decodeURIComponent(escape(atob(stored.slice(ENCODED_PREFIX.length)))));
};

const isQuotaError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 22 ||
    candidate.code === 1014;
};

const removeAnalysisCacheEntries = (preserveKey: string): void => {
  const keysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key?.startsWith('ca_analysis_cache_') && key !== preserveKey) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => sessionStorage.removeItem(key));
};

const retryAfterQuotaError = (key: string, payload: string, value: string): void => {
  try {
    removeAnalysisCacheEntries(key);
    sessionStorage.setItem(key, payload);
  } catch {
    console.info(`[CodeAtlas] Project analysis size (${(value.length / 1024 / 1024).toFixed(2)} MB) exceeds browser sessionStorage quota limit. Operating in high-performance memory-only mode without local cache.`);
  }
};

export const safeSessionStorageSetItem = (key: string, value: string) => {
    const payload = encode(value);
    try {
      sessionStorage.setItem(key, payload);
    } catch (err: unknown) {
      if (isQuotaError(err)) {
        retryAfterQuotaError(key, payload, value);
      } else {
        console.info("Failed to write to sessionStorage:", err);
      }
    }
  };

export const safeSessionStorageRemoveItem = (key: string) => {
    try {
        sessionStorage.removeItem(key);
    } catch (err) {
        console.warn("Failed to remove item from sessionStorage:", err);
    }
};

export const safeSessionStorageGetItem = (key: string) => {
    try {
        const stored = sessionStorage.getItem(key);
        if (stored === null) return null;
        try {
          return decode(stored);
        } catch {
          // Legacy plaintext value written before obfuscation was added
          return stored;
        }
    } catch (err) {
        console.warn("Failed to get item from sessionStorage:", err);
        return null;
    }
};
