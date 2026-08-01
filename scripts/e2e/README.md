# e2e auth harness (dev only, local only)

Headless tests that drive the auth/registration surface against **dev.naisi.uk**
without a human inbox, so it stops being hand-verified.

Plain Node — `node --test`, no new npm dependencies, **zero files under `src/`**.
Nothing here ships to production, so there is no production guard that can be
forgotten. It is run by hand from a laptop; there is no CI (see below).

```sh
cp .env.e2e.local.example .env.e2e.local   # then fill in DEV values
npm run e2e
```

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
- **It writes nothing to Firestore.** dev holds real members' data. The harness
  reads only; its sole mutations anywhere are creating and deleting its own
  `e2e-<id>@e2e.invalid` Auth accounts. Both properties are enforced offline by
  `tests/e2e-no-privilege-grants.test.mjs`, which runs under `npm test`.
- **It sends no email.** Every address in the Phase 1 batteries is rejected
  before the route reaches a send. `.invalid` is RFC 2606 reserved and can never
  receive mail, so even a mistake cannot reach a real inbox or bounce against
  the domain production's deliverability depends on.
- **Teardown cannot delete a real account.** `deleteHarnessUser` refuses any uid
  whose email is outside the `e2e-…@e2e.invalid` namespace.

## Secrets

`.env.e2e.local` (git-ignored via `.env*`) holds the **dev** project's values.
Never put production credentials in it.

`EVENTS_TOKEN_SECRET` is optional: without it the token-negative battery skips
rather than fails, so the #209 guard still runs. With it, the harness mints
magic links exactly as the server does — which is why the design brief rejected
dev-only "preview the email" pages. A script holding the dev secret needs no
such page, and the page would have handed the same capability to anyone able to
load it, recreating #209.

The secret is a **Secret Manager reference resolved per project**
(`apphosting.yaml`), so the value must be the *dev backend's* one or every
minted token is rejected. The positive control in `token-negatives` diagnoses
exactly that: a validly-signed token for an unknown doc id must return **404**,
not 400.

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
