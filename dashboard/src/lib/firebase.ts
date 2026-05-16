import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// -----------------------------------------------------------------------------
// IMPORTANT: FIREBASE CONFIGURATION
// -----------------------------------------------------------------------------
// For security, DO NOT hardcode your Firebase credentials here.
// Instead, use environment variables and a build process to inject them.
//
// Example using Vite:
// 1. Create a .env.local file in the /dashboard directory.
// 2. Add your Firebase config there, prefixed with VITE_:
//    VITE_FIREBASE_API_KEY=your-api-key
//    VITE_FIREBASE_AUTH_DOMAIN=your-auth-domain
//    ...
// 3. Access them in this file like this:
//    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
//
// This ensures your keys are not committed to version control.
// -----------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ""
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;
