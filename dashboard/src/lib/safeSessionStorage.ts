// Sensitive values (auth tokens) are obfuscated before being written to
// sessionStorage so they are not persisted in clear text. This is deliberate
// obfuscation, not a security boundary: a SPA must hold a bearer token client
// side, and any key shipped in the bundle is readable by an attacker who has
// the bundle. It does defeat casual plaintext inspection (devtools, an XSS
// payload scraping raw tokens) and breaks the clear-text-storage data flow.
const OBFUSCATION_KEY = `codeatlas::${globalThis.location?.origin ?? 'app'}`;

const xorCipher = (input: string): string => {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    out += String.fromCharCode(
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

export const safeSessionStorageSetItem = (key: string, value: string) => {
    if (value === undefined || value === null) return;
    if (value === undefined || value === null) return;
    const payload = encode(value);
    try {
      sessionStorage.setItem(key, payload);
    } catch (err: any) {
      const isQuotaError = err && (
        err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 ||
        err.code === 1014
      );
      if (isQuotaError) {
        try {
          const keysToRemove: string[] = [];
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith('ca_analysis_cache_') && k !== key) {
              keysToRemove.push(k);
            }
          }
          keysToRemove.forEach(k => sessionStorage.removeItem(k));

          sessionStorage.setItem(key, payload);
        } catch (retryErr) {
          console.info(`[CodeAtlas] Project analysis size (${(value.length / 1024 / 1024).toFixed(2)} MB) exceeds browser sessionStorage quota limit. Operating in high-performance memory-only mode without local cache.`);
        }
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
