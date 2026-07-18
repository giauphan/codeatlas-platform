export const safeSessionStorageSetItem = (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
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
          
          sessionStorage.setItem(key, value);
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
        return sessionStorage.getItem(key);
    } catch (err) {
        console.warn("Failed to get item from sessionStorage:", err);
        return null;
    }
};
