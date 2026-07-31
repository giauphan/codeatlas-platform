import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'CodeAtlasCache';
const DB_VERSION = 1;
const STORE_NAME = 'analysisCache';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

export async function setCacheItem(key: string, data: unknown): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE_NAME, data, key);
  } catch (err) {
    console.warn('[IndexedDB] Failed to set cache item:', err);
  }
}

export async function getCacheItem<T>(key: string): Promise<T | undefined> {
  try {
    const db = await getDb();
    return await db.get(STORE_NAME, key) as T | undefined;
  } catch (err) {
    console.warn('[IndexedDB] Failed to get cache item:', err);
    return undefined;
  }
}

export async function removeCacheItem(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, key);
  } catch (err) {
    console.warn('[IndexedDB] Failed to remove cache item:', err);
  }
}

export async function clearCache(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE_NAME);
  } catch (err) {
    console.warn('[IndexedDB] Failed to clear cache:', err);
  }
}
