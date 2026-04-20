import "server-only";
import {
  initializeApp,
  getApps,
  cert,
  type App,
  applicationDefault,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let _app: App | undefined;

function init(): App | undefined {
  if (_app) return _app;
  if (getApps().length) {
    _app = getApps()[0];
    return _app;
  }

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  try {
    if (projectId && clientEmail && privateKey) {
      _app = initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Firebase App Hosting injects ADC automatically.
      _app = initializeApp({ credential: applicationDefault() });
    } else {
      // No admin creds yet (e.g. local dev before .env populated).
      // Return undefined; callers should handle this gracefully.
      return undefined;
    }
  } catch (err) {
    console.error("[firebase-admin] initialization failed:", err);
    return undefined;
  }
  return _app;
}

export function getAdminAuth(): Auth | undefined {
  const app = init();
  return app ? getAuth(app) : undefined;
}

export function getAdminDb(): Firestore | undefined {
  const app = init();
  return app ? getFirestore(app) : undefined;
}
