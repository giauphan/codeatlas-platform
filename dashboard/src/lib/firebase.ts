/**
 * Firebase Web SDK initialization — only loads if VITE_FIREBASE_API_KEY is set.
 * If not configured, the app runs in API-key-only mode.
 */
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ""
};

// Only initialize Firebase if we have a real API key (not a dummy/placeholder)
const isRealKey = firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('dummy') &&
  !firebaseConfig.apiKey.startsWith('placeholder');

let app: any, auth: any, db: any;
if (!isRealKey) {
  console.warn("[Firebase] VITE_FIREBASE_API_KEY not set — Firebase disabled, API key mode only");
} else {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch {
    console.warn("[Firebase] init failed — Firebase disabled");
  }
}

export { auth, db };
export default app;
