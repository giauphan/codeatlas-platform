# CodeAtlas Management Dashboard

Professional dashboard for managing users and API keys for the CodeAtlas MCP Server.

## Architecture

### 1. Authentication flow

- **Frontend**: Uses Firebase Auth for login/registration.
- **State**: The dashboard uses the `onAuthStateChanged` hook to track user state. If not logged in, the user is redirected to the Auth page (Login/Signup).
- **Authorization**: Each API key is attached to the user's `uid` in Firestore under the schema `users/{uid}/keys/{keyId}`.

### 2. MCP Server authentication via Firestore

- **Mechanism**: Instead of using a static environment variable, the MCP Server uses `firebase-admin` to query Firestore directly.
- **Logic**: When a request arrives (via SSE or stdio), the server takes the API key and runs a `collectionGroup` query on the `keys` collection.
- **Validation**: If a document is found with a `key` field matching the submitted key, access is granted and the `lastUsed` timestamp is updated for that key.
- **Security**: This allows revoking a key immediately by deleting it from the dashboard without restarting the MCP Server.

## Setup

### Step 1: Configure Firebase project

1. Visit the [Firebase Console](https://console.firebase.google.com/).
2. Create a new project or select an existing one.
3. Enable **Authentication** (Email/Password).
4. Create a **Cloud Firestore** database.
5. Create a Web App and copy the config object into `dashboard/src/lib/firebase.ts`.

### Step 2: Set up Firestore security rules

Ensure the rules allow users to manage their own keys:

```javascript
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/keys/{keyId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // Allow MCP Server (Admin SDK) to query via collectionGroup
    match /{path=**}/keys/{keyId} {
      allow read: if false; // Only Admin SDK has global access
    }
  }
}
```

### Step 3: Configure MCP Server (Admin SDK)

1. In the Firebase Console, go to **Project Settings > Service Accounts**.
2. Click **Generate new private key** to download the JSON file.
3. Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of this JSON file on the machine running the MCP Server.

### Step 4: Run the dashboard

```bash
cd dashboard
pnpm install
pnpm run dev
```

## Features

- **Premium modern dark mode UI**: Modern dark interface using Framer Motion for smooth animations.
- **Key management**: Create, name, and delete API keys easily.
- **Usage tracking**: Track when each key was last used (Last Used).
- **Responsive**: Works well across multiple devices.

### UX Scripts

- \`patch_css.js\`: Programmatically adds the \`.clear-search-button\` utility class to \`index.css\` if missing to ensure UX styling integrity for the clear search button.
