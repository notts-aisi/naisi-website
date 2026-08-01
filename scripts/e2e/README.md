# e2e auth harness (dev only, local only)

Headless tests that drive the auth/registration surface without a human inbox,
so it stops being hand-verified. Two modes:

- **`npm run e2e`** — against **dev.naisi.uk** (the deployed dev backend).
  The reCAPTCHA-gated `/api/register` batteries and everything that reads
  email bodies skip in this mode; nothing here can make dev send mail.
- **`npm run e2e:local`** — the full suite. `scripts/e2e/run.mjs` builds and
  starts the real app on `127.0.0.1:3100` with Google's always-pass reCAPTCHA
  test secret and SMTP pointed at a loopback **Mailpit**, runs every battery
  against it, and tears it all down. `-- --skip-build` reuses the previous
  local build. See "The local server" below before trusting or changing it.

Plain Node — `node --test`, no new npm dependencies, **zero files under `src/`**
(one exception: the optional `FIREBASE_ADMIN_SERVICE_ACCOUNT_ID` hook in
`src/lib/firebase/admin.ts`, inert unless that env var is set, which only
run.mjs does). Nothing here ships to production, so there is no production
guard that can be forgotten. It is run by hand from a laptop; there is no CI
(see below).

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project naisi-website-dev
cp .env.e2e.local.example .env.e2e.local   # no secrets go in it
brew install mailpit                        # only needed for e2e:local
npm run e2e         # against dev.naisi.uk
npm run e2e:local   # everything, against a local server it starts itself
```

When you are done, `gcloud auth application-default revoke` removes the
laptop's access to the project entirely.

## What it covers today

| Battery | What it protects |
| --- | --- |
| `uni-email-gate` | **The PR #209 regression guard.** `/api/verify-email/send` must refuse a non-Nottingham address. Had this existed, the "anyone becomes a verified member" bypass could not have shipped. |
| `token-negatives` | Tampered signature, edited body, expired token, unsigned expiry extension, and cross-scope replay from all three other token scopes. Nobody hand-tests these, because producing them means forging an HMAC. |
| `password-set` | The server-random throwaway password is really replaced, the old session really revoked, and the recovery re-auth works. |
| `uni-email-stamp` | The two-phase `uniEmailVerifiedAt` stamp (PR #216) and its survival of the password-set session revocation (PR #221). |
| `recaptcha-gate` | The reCAPTCHA gate is actually live on every deployed backend — a junk token must bounce with 400. The one battery that touches production, safe precisely because it fails the gate. |
| `register-enumeration` | Account-enumeration uniformity on `/api/register`. **Local mode only** — see below. |
| `register-email-flow` | **Local mode only.** What `/api/register` puts in the inbox: the emailed magic link is extracted from the captured body and *driven*; the cooldown and the verified-account branch send nothing; the link → session → password chain ends in a working credential; links are absolute; no render artefacts. |
| `uni-email-inbox` | **Local mode only.** Enumeration uniformity extends to the inbox on the uni-email leg: the caller-visible responses stay indistinguishable, the duplicate case sends the already-registered notice with **no verify link** and a masked (never full) account address, the fresh case's emailed token matches the response's, nothing leaks uids or other recipients. |

## Safety properties

These are deliberate and enforced, not aspirational:

- **It cannot touch production.** `lib/env.mjs` exact-matches the target origin
  against an allowlist and names the production origins explicitly so aiming at
  one fails loudly. The Admin credential is pinned to the literal
  `naisi-website-dev`, checked on both the project id and the service-account
  email — `.env.prod` and `.env.local.prod-snapshot-*` sit in this repo root
  carrying the production project, and a stray `cp` must not silently re-aim
  the harness.
- **It grants no privileges.** Accounts it creates are bare Auth users, or (in
  the Phase 2+ batteries) users with a seeded document whose role is hard-coded
  to `pending` — the lowest role there is, which grants access to nothing. The
  design brief caps any future fixture ladder at `member`.
- **Firestore access is allowlisted to three collections** — `users`,
  `emailVerifications`, `registrations` — and nothing else. Phase 1 held the
  line at "no Firestore handle at all"; Phase 2 needed reads/seeds to prove the
  two-phase stamp, and Phase 3 added *delete-only* access to the signup tracker
  so route-created accounts don't leave ghost rows. Every write is namespaced
  to harness accounts and ledgered for teardown. Enforced offline by
  `tests/e2e-no-privilege-grants.test.mjs` under `npm test`, which also calls
  the real `assertTarget()` against a battery of production spellings
  (userinfo tricks, trailing dots, `www.`, uppercase) rather than
  pattern-matching the allowlist's source.
- **It cannot cause real email, and the guard is a proof rather than a
  promise.** In dev mode every address the batteries submit is rejected before
  the route reaches a send, and the uni-email leg is seeded directly instead of
  calling the send route. In local mode run.mjs forces the server's SMTP onto
  the loopback Mailpit. Fixture addresses are `.invalid` (RFC 2606 — no DNS, no
  inbox) except the uni-leg's `e2e-…@nottingham.ac.uk` fixtures, and *those*
  are gated on evidence: before using a real-domain address, `uni-email-inbox`
  sends to a `.invalid` probe and requires it to land in Mailpit, skipping if
  it does not. An env-var check alone would not do — an operator debugging by
  hand can set the variable while pointed at their own `npm run dev`, whose
  SMTP is the real credentials in `.env.local`.
- **Every uid- or address-taking helper re-checks the namespace**, so no single
  mistaken argument can reach real data. `deleteHarnessUser` and
  `sessionCookieForUid` resolve the account and refuse anything outside
  `e2e-…@e2e.invalid`; `deleteRegistrationRow` re-reads the row first;
  `deleteEmailVerificationsFor` matches the two fixture namespaces in full
  rather than a bare `e2e-` prefix (which would also accept plausible real
  addresses like `e2e-lab@gmail.com`).
- **Crashed runs get swept.** Cleanup lives in each battery's `after()` hook,
  which a killed process never reaches, so `e2e:local` also sweeps harness
  accounts older than an hour at start-up — old enough that it can never touch
  a concurrent run.

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

## The local server (`npm run e2e:local`)

`run.mjs` is the only supported way to run the register/Mailpit batteries, and
its job is mostly refusing to do things:

- **Loopback or nothing.** The server is started with `-H 127.0.0.1` (Next
  otherwise binds every interface) and Mailpit is bound to `127.0.0.1` on both
  its SMTP and HTTP sockets. A captcha-relaxed registration endpoint must never
  be LAN-reachable — on a public host it is a mail relay aligned with
  production's sending domain.
- **The relaxation lives only in the child process's environment.** Google's
  published always-pass test secret and the Mailpit SMTP override are injected
  into the spawned server's env; no env file is written and nothing deployed
  reads this script. run.mjs also *refuses* a server already listening on the
  port, because it cannot know what environment that process carries.
- **Dev project asserted on the EFFECTIVE environment**, not just the file.
  Next resolves `process.env` > `.env.production.local` > `.env.local`, and the
  child inherits this shell — so checking only `.env.local` would let exported
  production values (`set -a; source .env.prod`) through. Both project ids must
  resolve to `naisi-website-dev` wherever they come from, a
  `FIREBASE_ADMIN_PRIVATE_KEY`/`CLIENT_EMAIL` from *any* source is refused
  (this machine is ADC-only), `FIREBASE_ADMIN_SERVICE_ACCOUNT_ID` must name a
  dev service account, and a `.env.production*` file — which would outrank
  everything validated — aborts the run. Both project ids are then also *forced*
  in the child's env, so a future relaxation of a check still cannot re-aim it.
- **Per-run token secret.** `EVENTS_TOKEN_SECRET` is a fresh random value
  handed to both the server and the test process (`E2E_LOCAL_TOKEN_SECRET`),
  so local runs never touch Secret Manager and a stale secret cannot cause a
  silent mismatch. `lib/env.mjs` refuses the local secret when the target is
  not loopback.
- **The build is part of the run.** `NEXT_PUBLIC_APP_URL` is inlined at build
  time, so emailed links only point at the local server if the build was made
  for it — hence the build marker in `.next/` and the `--skip-build` guard
  that rebuilds when the marker disagrees. run.mjs refuses to build while
  something (a dev server) is listening on :3000, because `next build`
  clobbers the `.next` that server is running from.
- **Serial test files.** Batteries share one server and one mail catcher, so
  run.mjs passes `--test-concurrency=1`; mail assertions are additionally
  per-recipient (addresses embed the run id) so leftovers can never satisfy a
  wait.
- **Mailpit reuse is settled, not assumed.** A third gotcha, found by running
  the suite back-to-back: a *shutting-down* Mailpit still answers HTTP for a
  moment, so a single liveness probe made the next run decide to "reuse" an
  instance that then vanished (`ECONNREFUSED` on the first mailbox wipe). Two
  fixes, both kept: the runner now probes twice across a gap before reusing,
  and waits for its own children to actually exit rather than returning while
  one still holds the port. If Mailpit disappears anyway, the mailbox wipe
  restarts it instead of failing the run.
- **If a run is SIGKILLed, clean up by hand.** The teardown paths handle a
  normal exit, `fail()`, and SIGINT/SIGTERM — but nothing survives `kill -9`,
  so a hard kill (or a CI/agent harness reaping the process group) orphans the
  server on `:3100` and possibly Mailpit on `:8025`. The next run then refuses
  with "already listening on :3100", which is correct and not a bug. Fix:
  `kill $(lsof -ti TCP:3100 -sTCP:LISTEN)`, same for `8025`. Symptom worth
  recognising: a run that reuses an *orphaned* Mailpit can have it vanish
  mid-suite, and the mail batteries then skip with "Mailpit is not answering"
  rather than failing — green-looking output that proved nothing.
- **It only kills what it started.** run.mjs reuses a Mailpit that is already
  running and leaves it alone; it spawns (and later kills) one only when none
  is there. So to *read* the captured mail after a run — Mailpit's DB is
  in-memory and dies with the process — start it yourself first (`mailpit`)
  and then run the suite; the UI at <http://127.0.0.1:8025> survives, and
  that is the "preview the emails" experience the original design brief
  wanted, on loopback instead of on dev.naisi.uk.

What a local run leaves behind on the **dev** project, honestly: the register
route increments `signupMetrics` daily counters and appends `emailSends` log
rows (both admin-dashboard surfaces; the rows are self-identifying —
`e2e-…@e2e.invalid` / `NAISI (e2e)`), and those are NOT cleaned up because the
harness's Firestore allowlist deliberately excludes those collections. The
Auth users, `registrations` rows and `emailVerifications` docs it causes ARE
cleaned up. This is the same residue a human testing registration against dev
leaves, minus the accounts.

## Known holes — green here does NOT mean covered

Read this before trusting a passing run.

- **Google sign-in is not covered and is not automatable.**
  `src/auth/signInWithGoogle.ts` documents that GIS/FedCM was chosen *because*
  extensions and interceptors cannot reach it; the same property defeats
  scripted automation. The harness signs in with a custom token, which decodes
  with `firebase.sign_in_provider === "custom"`, so the Google-orphan branch in
  `src/app/api/auth/session/route.ts` (`recordGoogleRegistrationCreated`) never
  executes. Keep Google as a manual smoke check before every `dev` → `main`.
- **This harness covers `firestore.rules` not at all**, and always will: it
  seeds through the Admin SDK, which bypasses rules entirely — and rules are
  what *contained* the #209 damage. That gap is filled by a separate emulator
  suite, `scripts/rules-tests/` (PR #223), which is where any rules assertion
  belongs. The **Auth emulator is permanently out of scope** for both, because
  `FIREBASE_AUTH_EMULATOR_HOST` makes firebase-admin verify JWTs with
  `algorithms: ['none']` and `/api/auth/session` calls `verifyIdToken` on a
  request-body field — one stray env var would mint a session for any uid,
  including an admin's.
- **Nothing here proves infrastructure.** Not Secret Manager wiring, not the
  `serviceAccountTokenCreator` IAM grant, not `auth-dev.naisi.uk`, not Resend
  DKIM. **A green run does not replace the manual dev smoke pass.** The local
  server sharpens this: it runs with a test captcha secret, loopback SMTP and
  a made-up token secret, so `e2e:local` proves the *code paths*, while the
  deployed dev backend's *wiring* (real secret resolution, real SMTP, real
  reCAPTCHA keys) is only proven by `npm run e2e` against dev plus the manual
  pass.
- **`/api/register` is covered in local mode only.** Against dev it stays
  behind the reCAPTCHA gate on purpose (that gate being closed is itself
  asserted by `recaptcha-gate`, on dev *and* production).
- **Email coverage is the three auth templates only** — `VerifyLoginEmail`,
  `VerifyUniEmail`, `AlreadyRegisteredEmail`, exercised through their real
  routes. The other `src/emails/` templates (newsletter, RSVP, task,
  application emails) render only when their flows run and are still
  uncovered here.
- **A live maintenance notice does not affect these tests** — the site-notice
  pause flags are client-side only and no API route consults them. A future
  browser-driven test *would* be blocked whenever a notice is on.

## Why there is no CI

There is no `.github/` in this repo, and a dev service-account key in GitHub
Actions on a **public** repo is where this stops being safe. Run it locally.
