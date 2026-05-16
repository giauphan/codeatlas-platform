import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config();

// We'll try to call the REST endpoint for collectionGroup query
// This requires an OAuth token, but even an unauthenticated call 
// to the right endpoint often reveals the index link in the error.

async function getLink() {
  const projectId = "atlas-intelligence-node";
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'keys', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'key' },
          op: 'EQUAL',
          value: { stringValue: 'test-trigger' }
        }
      },
      limit: 1
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(e);
  }
}

getLink();
