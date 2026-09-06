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
- **`npm run e2e:funnel`**: the APPLICANT FUNNEL in a real browser (Chromium
  only): seed a throwaway intake and pre-course, drive a fake applicant through
  apply, withdraw, re-apply, enrol and drop out, then tear the fixture down and
  prove its manifest reads zero. It sits beside these batteries but is a
  different kind of test and needs Playwright, which this repo deliberately
  does not depend on. Against dev the apply leg is SKIPPED and reported (the
  real reCAPTCHA widget challenges headless Chromium); `-- --local` drives all
  thirteen steps. See "The applicant funnel" below.

Plain Node — `node --test`, no new npm dependencies, **zero files under `src/`**
(one exception: the optional `FIREBASE_ADMIN_SERVICE_ACCOUNT_ID` hook in
`src/lib/firebase/admin.ts`, inert unless that env var is set, which only
run.mjs does). Nothing here ships to production, so there is no production
guard that can be forgotten. It is run by hand from a laptop and is not in CI
(see the last section for why).

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
- **A browser needs the other half of the relaxation.** The fetch batteries
  post a junk token string and the always-pass secret accepts it. A browser
  cannot: the client widget yields no token without a site key, and once a
  secret is set the server treats a missing token as a refusal, so every
  reCAPTCHA-gated route answered the funnel's first run with "recaptcha
  refused". Google's published test *site* key does not help either (it is a
  Checkbox key and the widget renders as Invisible, which fails with "Invalid
  key type"). So run.mjs inlines a non-empty, self-describing site key so the
  widget mounts, and the browser specs serve a stub `api.js` from Playwright
  (`lib/browser.mjs`, `stubRecaptchaOnLoopback`) that calls back a fixed
  token. The stub arms only when the target is loopback; against dev the real
  widget runs against the real secret. A spec waits for the widget to mount
  (`waitForRecaptchaWidget`) before every gated press, because a person takes
  seconds to press Start and a spec takes milliseconds, and the third run
  lost to that race. The site key is part of the build marker, since it is
  inlined at build time.
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

## The applicant funnel (`npm run e2e:funnel`)

A browser-driven run over the whole applicant journey, so a dress rehearsal is
one command rather than an afternoon of clicking. Different in kind from the
batteries above: those are `fetch()` against routes, this one is Chromium
driving the actual pages.

**The exact sequence, both modes:**

```sh
# one-time, per machine (see "Credentials" above for the gcloud half)
cp .env.e2e.local.example .env.e2e.local
npm install --no-save playwright     # NOT a dependency: see below
npx playwright install chromium

# against the deployed dev backend
npm run e2e:funnel

# against a server the run starts itself (captcha relaxed, SMTP on loopback)
npm run e2e:funnel -- --local
npm run e2e:funnel -- --local --skip-build   # reuse the previous local build

# fewer or more fake applicants (1 to 10, default 5)
npm run e2e:funnel -- --applicants 2

# the fixture on its own, when you want to click around it by hand
node scripts/seed-fake-applicants.mjs up
node scripts/seed-fake-applicants.mjs status   # the manifest, right now
node scripts/seed-fake-applicants.mjs down     # must end with total: 0
```

**What it drives**, in order, as one ordered test with named steps
(`tests/e2e/applicant-funnel.spec.mjs`):

1. the public course page renders the seeded session slots;
2. `/apply/[roundId]` gives a signed-out visitor the sign-in gate and does NOT
   render the form behind it;
3. applicant 1 signs in through the real `/login` form;
4. starting an application opens an editable draft;
5. the draft saves, and the save bar says so;
6. a reload brings the answer back off the server;
7. the availability grid paints under a real pointer drag, and the marks
   survive a save and a reload;
8. submitting moves the application to view-only, with the controls gone
   rather than disabled;
9. withdrawing is refused until the confirmation word is typed;
10. picking it back up restores every answer, and it submits again;
11. the status hub at `/applications` lists the round;
12. taking a place in a pre-course session;
13. leaving the course, behind the typed course title.

Step 11 used to skip while `/applications` 404ed. The status hub has landed,
the step ran for real on 6 September 2026, and a 404 there now fails the run:
the page an applicant is told to come back to is not allowed to be missing.

**Against dev, steps 4 to 11 are skipped and the run says so.** Start, Submit
and Pick it back up each send a reCAPTCHA token, and Google's real widget
answers headless Chromium with an image challenge ("Select all images with
crosswalks", found on the first dev run, 6 September 2026). No spec may solve
one: the gate being closed to automation is the property the `recaptcha-gate`
battery asserts. The spec skips exactly the steps in
`RECAPTCHA_DEPENDENT_STEPS` (the gated presses and the steps that need what
they create), records each with its reason in the completion marker, and the
runner accepts that set in dev mode, prints it as "SKIPPED, not run", and
treats any other skip, or any skip in `--local` mode, as a failure. So the
dev-mode funnel proves sign-in, the public course page, the signed-out gate
and the enrol and drop-out leg against the real backend; the apply leg is
proven in local mode, the same split the register batteries already have.

**CHROMIUM ONLY.** Playwright drives Chromium here and nothing else, so this is
a regression net and **never** a substitute for the manual Safari pass before
`dev` goes to `main`. This codebase has already shipped a Safari-only defect (a
`<button>` whose inline background WebKit painted its own grey face over), and
Google sign-in is not automatable at all by design (see "Known holes").

**Playwright is not a dependency, on purpose.** The root `package.json` is what
App Hosting runs `npm ci` against on the critical path of every production
deploy, and a browser-automation library plus a downloaded Chromium has no
business there. That is the same argument that put the rules tests in
`scripts/rules-tests/` with their own manifest. So `npm install --no-save`
keeps it out of `package.json` and the lockfile, and the runner **refuses to
run** without it: it prints the install line and exits non-zero before seeding
anything, because a run that cannot open a browser has nothing to say about the
funnel and is not worth the rows on a shared project. (Running the spec file
directly still skips, which is what a bare `node --test tests/` needs.)

**A run that drove no browser fails.** Every way the spec can decline to run
(no Playwright, no fixture, a skip) exits `node --test` at 0, which is
indistinguishable from a pass. So each step records its name as it finishes,
the list is written to `.e2e-funnel-steps.json`, and the runner deletes that
file before the run and refuses to report success unless it comes back naming
every step in `FUNNEL_STEPS`. When it does not, the run exits non-zero with the
step it stopped at.

Both scratch files (`.e2e-funnel-state.json`, the fixture ledger, and
`.e2e-funnel-steps.json`) sit at the repo root and are gitignored. They are
deliberately **not** under `.next/`: `next build` clears that directory, so in
`--local` mode the ledger was deleted by the build before the spec ever looked
for it, and the run skipped its way to a green exit. `tests/funnel-harness-guards.test.mjs`
pins both paths out of the build output.

**A failed step leaves the page behind.** A selector timeout says what the
spec wanted and nothing about what the page showed instead, and on the first
real run that difference was the whole diagnosis (the form never appeared
because the route had refused the reCAPTCHA token, which only the server log
said). So a step that throws writes a full-page screenshot and the page's text
to `.e2e-artifacts/<step-name>.png|txt` (`ARTIFACTS_DIR`, gitignored, pinned
outside `.next/` by the same guard) before the failure is reported.

**One known defect is pinned rather than papered over.** The public course
page renders `CourseCTA` twice (hero and foot) and each placement mounts its
own `GroupPicker` with its own state. The spec drives the hero picker (first
in document order, `.first()`), and after the drop-out step asserts that the
foot picker *still* offers "Take this place" (it never learns the hero one
left; the button cannot succeed, the route refuses a second create, so the
harm is a contradiction on the page). The assertion is written so that fixing
the defect fails the step with the instruction to delete the pin, the same
shape as `KNOWN_MISSING_INDEXES` in the index guard.

### The fixture, and why teardown is the headline

`scripts/seed-fake-applicants.mjs` creates, in the dev project:

- N throwaway accounts (`e2e-<id>@e2e.invalid`, the auth harness's own
  namespace) each with a `users` document at role `pending`;
- one `admissionRounds` document in status `open` with one released stage, the
  default 09:00 to 18:00 quarter-hour availability grid, and no reviewers or
  final decider;
- one open-enrolment `courseRuns` pre-course under a published `courses`, with
  two capped `courseGroups` (2 places and 1, so "full" is reachable in a single
  run).

Teardown removes all of it, plus everything the ROUTES created underneath
(applications and their private rows, enrolments, audit rows, cohort
subscription rows and their event lines, mirrored tasks, progress), and then
**counts every one of those collections again**. A run whose suite was green
but whose teardown left rows behind still exits non-zero: the fixture lives on
a shared dev project, so a stray open round on the catalogue is as much a
defect as a failed assertion. The manifest counts the `users` document and the
Auth account each fixture applicant owns alongside the thirteen collections, so
a teardown that stranded either is a non-zero total rather than a clean one,
and a delete it refused (an account whose address is outside the harness
namespace) is recorded in the manifest instead of logged and forgotten.
Teardown runs in a `finally`, leaves the state file in place when anything is
still standing, and an interrupted run says exactly which command clears up
(`node scripts/seed-fake-applicants.mjs down`).

### Its own fence, and why it is not inside this directory

`tests/e2e-no-privilege-grants.test.mjs` holds the AUTH harness to three
Firestore collections. The funnel fixture needs thirteen, so it cannot live
inside that fence without tearing it down, and it sits at `scripts/` with a
fence of its own shape, enforced by `tests/funnel-harness-guards.test.mjs`
under `npm test`:

- **It can never be aimed at production.** The spec resolves its origin through
  the auth harness's own `assertTarget()`, and the guard asserts the production
  origin appears nowhere in the harness as a literal.
- **It grants no privilege.** Accounts are role `pending`, written by the auth
  harness's hard-coded seeder. The guard forbids any other role literal, a
  `permissions` map, `suRecognised`, `setCustomUserClaims`, and (specific to
  this fixture) a non-empty `reviewerUids`, a non-null `finalDeciderUid`, or a
  populated facilitator array: naming a reviewer would be minting a review
  permission.
- **It reaches only its declared collections.** One checked chokepoint,
  `assertFixtureCollection()`, which throws before any credential is obtained,
  tested behaviourally against both the list and a battery of collections it
  must refuse. The grep half then insists every `.collection(...)` in the
  harness is a literal on the list, the checked `collection` parameter of
  `fixtureDoc` / `fixtureQuery`, or one of exactly two named exceptions: the
  literal `users` (the document each fixture account owns, written by the auth
  harness's guarded seeder and deleted under a namespace re-check on the
  account it belongs to, and counted by the manifest so a stranded one shows
  up), and the identifier `STAGES_SUBCOLLECTION`, which names a subcollection
  reached off a document reference the chokepoint already produced. The guard
  pins that constant's value so the name cannot quietly become something else.

### It cannot cause real email

The drop-out route emails the member. Fixture addresses are `.invalid`
(RFC 2606, no DNS and no inbox), but against the deployed dev backend that
would still be a real hand-off to Resend and a hard bounce logged against the
sending domain. So seeding writes a `suppressedEmails` row for every fixture
address FIRST. The rows are ledgered and removed by teardown like everything
else.

Be precise about what that buys, because the suppression check is **not**
universal. `sendEmail()` in `src/lib/email/send.ts` does not consult the list
at all; the per-feature helpers do, individually. On the paths this run drives,
`sendCourseDroppedOutEmail()` in `courseEnrolmentEmails.ts` returns early on
`isSuppressed()` before it builds a message, and `courseFacilitatorEmails.ts`
drops suppressed addresses through `filterSuppressed()`. So the guarantee holds
for the routes the funnel touches, and `tests/funnel-harness-guards.test.mjs`
keeps it holding: it reads the `@/lib/email/*` imports of every route the spec
drives and fails if one of those helpers stops checking the list. That check
arms itself for new helpers automatically, which is what matters as the submit
route grows an `admissionEmails.ts`.

### It cannot be pointed at production, including "just once before launch"

The delivery plan carries a line about running this again against production on
19 Sep. That is structurally impossible and the harness refuses it, by design:
the spec resolves its origin through `assertTarget()`, which allowlists the dev
origin and loopback and nothing else, and the fixture calls `loadEnv()`, which
exact-matches the project against `naisi-website-dev` before any credential is
obtained. Nor would relaxing either be wanted: this run CREATES accounts,
applications, enrolments and an open admission round on the catalogue, and
proves itself by deleting them again. Rehearse on dev; the production pass
before launch stays a human clicking through.

### Local mode reuses `run.mjs` rather than copying it

`--local` delegates the whole server bootstrap to `scripts/e2e/run.mjs`: the
loopback bind, the always-pass captcha secret, the Mailpit SMTP override, the
effective-environment dev assertion, the build marker. The only hook it needed
was `E2E_TEST_PATHS`, which defaults to `scripts/e2e/tests/`, so `npm run
e2e:local` is unchanged. Two places that must agree about which environment is
safe to relax is exactly what that file exists to prevent.

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
- **Every browser-driven press behind reCAPTCHA is local mode only**, for the
  same reason from the other side: against dev the real widget challenges
  headless Chromium with images. Today that is the funnel's apply leg
  (`RECAPTCHA_DEPENDENT_STEPS`), skipped and reported in dev mode. Any future
  spec that drives `/register` or the admissions apply routes in a browser
  inherits the split.
- **Email coverage is the three auth templates only** — `VerifyLoginEmail`,
  `VerifyUniEmail`, `AlreadyRegisteredEmail`, exercised through their real
  routes. The other `src/emails/` templates (newsletter, RSVP, task,
  application emails) render only when their flows run and are still
  uncovered here.
- **A live maintenance notice does not affect these tests** — the site-notice
  pause flags are client-side only and no API route consults them. A future
  browser-driven test *would* be blocked whenever a notice is on.

## Why the harness is not in CI

`.github/workflows/checks.yml` (since #263) runs typegen, `tsc`, lint,
`npm test` and a real build on every pull request, with the rules emulator
suite as a second job. None of those need credentials, and the two offline
fences on this harness run there under `npm test`.

Neither e2e mode is in it. Local mode boots the app on loopback with Mailpit
and the test captcha secret, but the app it boots still creates real Auth
users and real Firestore rows on the dev project, so a CI job for *either*
mode needs dev credentials stored as GitHub Actions secrets on a **public**
repo. Whether that is acceptable is the owner's decision, not this file's.
Until it is made, run the harness by hand from a laptop with Application
Default Credentials, as above.
