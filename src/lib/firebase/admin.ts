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
      //
      // `projectId` is passed explicitly because without it the SDK resolves
      // the project from `gcloud config get-value project` — a machine-wide
      // setting that has nothing to do with this repo. On a laptop whose
      // gcloud default is production, a local `npm run dev` running on ADC
      // would silently read and write PRODUCTION data. Undefined here on App
      // Hosting (no FIREBASE_ADMIN_* is set there, by design — see
      // apphosting.yaml), where the metadata server supplies it as before.
      //
      // `serviceAccountId` names the service account IAM signs custom tokens
      // as when the credential itself cannot sign (a user ADC has no private
      // key; the caller needs roles/iam.serviceAccountTokenCreator on that
      // account). On App Hosting it stays undefined — the metadata server
      // already supplies a signing identity — so this only takes effect for a
      // local server run under `gcloud auth application-default login`, where
      // createCustomToken (the login magic-link confirm) would otherwise fail.
      // It is REQUIRED to belong to `projectId`. Tokens are signed by whichever
      // account this names, so an id from another project — a stale line in
      // .env.local, a copied snapshot — would have a dev-pinned app minting
      // custom tokens valid against PRODUCTION, which is exactly the direction
      // the projectId pin above exists to prevent. Ignored with a loud warning
      // rather than honoured, so the failure is "createCustomToken doesn't
      // work" and not a silent cross-project signing capability.
      const serviceAccountId = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_ID;
      const signerMatchesProject =
        !!serviceAccountId && !!projectId && serviceAccountId.endsWith(`@${projectId}.iam.gserviceaccount.com`);
      if (serviceAccountId && !signerMatchesProject) {
        console.error(
          `[firebase-admin] IGNORING FIREBASE_ADMIN_SERVICE_ACCOUNT_ID=${serviceAccountId}: ` +
            `it does not belong to project ${projectId}. A signer from another project would ` +
            "mint custom tokens valid against that project.",
        );
      }
      _app = initializeApp({
        credential: applicationDefault(),
        projectId,
        ...(signerMatchesProject ? { serviceAccountId } : {}),
      });
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
