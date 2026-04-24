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
import { getStorage, type Storage } from "firebase-admin/storage";

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
      // Explicit service-account creds (typical local dev setup).
      _app = initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    } else {
      // Fall back to Application Default Credentials. On Firebase App Hosting
      // / Cloud Run this reaches the instance metadata server automatically;
      // no env vars needed. Fails gracefully in local dev before `.env` is
      // populated — the catch below keeps the app from crashing.
      _app = initializeApp({ credential: applicationDefault() });
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

export function getAdminStorage(): Storage | undefined {
  const app = init();
  return app ? getStorage(app) : undefined;
}
