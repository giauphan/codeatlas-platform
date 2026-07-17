import { safeSessionStorageGetItem } from './safeSessionStorage';

/**
 * Shared auth helper for API requests
 */
export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const savedApiKey = safeSessionStorageGetItem('ca_api_key');
  if (!savedApiKey) {
    return { 'Content-Type': 'application/json' };
  }
  // API keys start with 'ca_' — send as x-api-key
  // Firebase ID tokens from email/password login — send as Bearer
  if (savedApiKey.startsWith('ca_')) {
    return { 'x-api-key': savedApiKey, 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${savedApiKey}`, 'Content-Type': 'application/json' };
};
