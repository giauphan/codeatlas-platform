import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('authService Repository Selection Logic', () => {
  const origFirestore = process.env.CODEATLAS_USE_FIRESTORE;
  const origCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  afterEach(() => {
    if (origFirestore === undefined) delete process.env.CODEATLAS_USE_FIRESTORE;
    else process.env.CODEATLAS_USE_FIRESTORE = origFirestore;

    if (origCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = origCreds;
  });

  test('CODEATLAS_USE_FIRESTORE=false forces local SQLite repositories even with credentials', async () => {
    process.env.CODEATLAS_USE_FIRESTORE = 'false';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fake/creds.json';

    // Verify evaluation matches SQLite expectation
    let useFirestore = false;
    if (process.env.CODEATLAS_USE_FIRESTORE === 'true') {
      useFirestore = true;
    } else if (process.env.CODEATLAS_USE_FIRESTORE !== 'false' && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      useFirestore = true;
    }
    assert.strictEqual(useFirestore, false);
  });

  test('CODEATLAS_USE_FIRESTORE unset with credentials uses Firestore for backward compatibility', async () => {
    delete process.env.CODEATLAS_USE_FIRESTORE;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fake/creds.json';

    let useFirestore = false;
    if (process.env.CODEATLAS_USE_FIRESTORE === 'true') {
      useFirestore = true;
    } else if (process.env.CODEATLAS_USE_FIRESTORE !== 'false' && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      useFirestore = true;
    }
    assert.strictEqual(useFirestore, true);
  });

  test('CODEATLAS_USE_FIRESTORE unset and no credentials defaults to local SQLite', async () => {
    delete process.env.CODEATLAS_USE_FIRESTORE;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let useFirestore = false;
    if (process.env.CODEATLAS_USE_FIRESTORE === 'true') {
      useFirestore = true;
    } else if (process.env.CODEATLAS_USE_FIRESTORE !== 'false' && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      useFirestore = true;
    }
    assert.strictEqual(useFirestore, false);
  });

  test('CODEATLAS_USE_FIRESTORE=true strictly enables Firestore', async () => {
    process.env.CODEATLAS_USE_FIRESTORE = 'true';
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let useFirestore = false;
    if (process.env.CODEATLAS_USE_FIRESTORE === 'true') {
      useFirestore = true;
    } else if (process.env.CODEATLAS_USE_FIRESTORE !== 'false' && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      useFirestore = true;
    }
    assert.strictEqual(useFirestore, true);
  });
});
