# e2e auth harness (dev only, local only)

Headless tests that drive the auth/registration surface against **dev.naisi.uk**
without a human inbox, so it stops being hand-verified.

Plain Node — `node --test`, no new npm dependencies, **zero files under `src/`**.
Nothing here ships to production, so there is no production guard that can be
forgotten. It is run by hand from a laptop; there is no CI (see below).

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project naisi-website-dev
cp .env.e2e.local.example .env.e2e.local   # no secrets go in it
npm run e2e
```

When you are done, `gcloud auth application-default revoke` removes the
laptop's access to the project entirely.

## What it covers today (Phase 1)

| Battery | What it protects |
| --- | --- |
| `uni-email-gate` | **The PR #209 regression guard.** `/api/verify-email/send` must refuse a non-Nottingham address. Had this existed, the "anyone becomes a verified member" bypass could not have shipped. |
| `token-negatives` | Tampered signature, edited body, expired token, unsigned expiry extension, and cross-scope replay from all three other token scopes. Nobody hand-tests these, because producing them means forging an HMAC. |
| `register-enumeration` | Account-enumeration uniformity on `/api/register`. **Skipped by default** — see below. |

## Safety properties

These are deliberate and enforced, not aspirational:

- **It cannot touch production.** `lib/env.mjs` exact-matches the target origin
  against an allowlist and names the production origins explicitly so aiming at
  one fails loudly. The Admin credential is pinned to the literal
  `naisi-website-dev`, checked on both the project id and the service-account
  email — `.env.prod` and `.env.local.prod-snapshot-*` sit in this repo root
  carrying the production project, and a stray `cp` must not silently re-aim
  the harness.
- **It grants no privileges.** Accounts it creates are bare Auth users with **no
  Firestore document**, so they hold no role at all — not even `pending`. The
  design brief caps any future fixture ladder at `member`.
- **It never reaches Firestore at all** — not to write, not to read. dev holds
  real members' data; the harness never obtains a Firestore handle. Its only
  mutations anywhere are creating and deleting its own `e2e-<id>@e2e.invalid`
  Auth accounts. Enforced offline by `tests/e2e-no-privilege-grants.test.mjs`
  under `npm test`, which also calls the real `assertTarget()` against a
  battery of production spellings (userinfo tricks, trailing dots, `www.`,
  uppercase) rather than pattern-matching the allowlist's source.
- **It sends no email.** Every address in the Phase 1 batteries is rejected
  before the route reaches a send. `.invalid` is RFC 2606 reserved and can never
  receive mail, so even a mistake cannot reach a real inbox or bounce against
  the domain production's deliverability depends on.
- **Teardown cannot delete a real account.** `deleteHarnessUser` refuses any uid
  whose email is outside the `e2e-…@e2e.invalid` namespace.

## Credentials — nothing permanent on disk

`.env.e2e.local` holds **no secrets**. It carries the target, the project id,
and the web API key, which is public by design (it ships in the client bundle).

- **Authentication** is Application Default Credentials, not a downloaded
  service-account key. A key file is a permanent credential in plaintext that
  any process running as you can read; ADC is a token you can revoke with one
  command. This also matches how the deployed app authenticates — see the
  `applicationDefault()` fallback in `src/lib/firebase/admin.ts`. The harness
  **rejects** a `FIREBASE_ADMIN_PRIVATE_KEY` in its config so a key cannot
  quietly come back.
- **`EVENTS_TOKEN_SECRET`** is read from Secret Manager at runtime and held in
  memory only. Without access the token batteries skip rather than fail, so the
  #209 guard still runs.

Two gotchas that cost an afternoon, recorded so they don't again:

1. The secret is a **Secret Manager reference resolved per project**, so the
   dev *backend's* value is **not** the one in `.env.local`. Mint with the
   wrong one and every token is rejected. The positive control in
   `token-negatives` diagnoses exactly this: a validly-signed token for an
   unknown doc id must return **404**, not 400.
2. `createCustomToken` cannot sign under user ADC without help — it asks IAM to
   sign instead, which needs `roles/iam.serviceAccountTokenCreator` on
   `firebase-adminsdk-fbsvc@naisi-website-dev…` (**`roles/owner` does not
   include it**), and needs the ADC **quota project set to dev** — with it left
   pointing at another project the call fails with the same
   `iam.serviceAccounts.signBlob` denial even once the role is granted.

## Known holes — green here does NOT mean covered

Read this before trusting a passing run.

- **Google sign-in is not covered and is not automatable.**
  `src/auth/signInWithGoogle.ts` documents that GIS/FedCM was chosen *because*
  extensions and interceptors cannot reach it; the same property defeats
  scripted automation. The harness signs in with a custom token, which decodes
  with `firebase.sign_in_provider === "custom"`, so the Google-orphan branch in
  `src/app/api/auth/session/route.ts` (`recordGoogleRegistrationCreated`) never
  executes. Keep Google as a manual smoke check before every `dev` → `main`.
- **`firestore.rules` is at 0% coverage.** The harness seeds through the Admin
  SDK, which bypasses rules entirely — and rules are what *contained* the #209
  damage. A Firestore-only rules suite (`@firebase/rules-unit-testing`) is the
  tool for that; the Auth emulator is permanently out of scope, because
  `FIREBASE_AUTH_EMULATOR_HOST` makes firebase-admin verify JWTs with
  `algorithms: ['none']` and `/api/auth/session` calls `verifyIdToken` on a
  request-body field — one stray env var would mint a session for any uid,
  including an admin's.
- **Nothing here proves infrastructure.** Not Secret Manager wiring, not the
  `serviceAccountTokenCreator` IAM grant, not `auth-dev.naisi.uk`, not Resend
  DKIM. **A green run does not replace the manual dev smoke pass.**
- **`/api/register` is untested** until Phase 3 supplies a local server — it is
  reCAPTCHA-gated, and its fresh-address branch sends real email through
  production's sender. The battery exists and is complete, but stays skipped
  behind `E2E_ALLOW_REGISTER=1` plus a localhost target.
- **A live maintenance notice does not affect these tests** — the site-notice
  pause flags are client-side only and no API route consults them. A future
  browser-driven test *would* be blocked whenever a notice is on.

## Why there is no CI

There is no `.github/` in this repo, and a dev service-account key in GitHub
Actions on a **public** repo is where this stops being safe. Run it locally.
