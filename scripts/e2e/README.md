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
- **`npm run e2e:browser`**: the BROWSER suite (Chromium only), every spec
  module under `scripts/e2e-fixtures/`: seed each throwaway world, drive it in
  a real browser, tear it down, and prove each manifest reads zero.
  **`npm run e2e:funnel`** is the same runner with `--spec applicant-funnel`,
  the applicant journey (apply, withdraw, re-apply, enrol, drop out). These sit
  beside the batteries above but are a different kind of test and need
  Playwright, which this repo deliberately does not depend on. Against dev the
  reCAPTCHA-dependent legs are SKIPPED and reported (the real widget challenges
  headless Chromium); `-- --local` drives them. See "The browser suite" below.

Plain Node — `node --test`, no new npm dependencies, **zero files under `src/`**
(one exception: the optional `FIREBASE_ADMIN_SERVICE_ACCOUNT_ID` hook in
`src/lib/firebase/admin.ts`, inert unless that env var is set, which only
run.mjs does). Nothing here ships to production, so there is no production
guard that can be forgotten. It runs by hand from a laptop, and in CI on every
pull request and nightly (see "In CI" at the end).

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project naisi-website-dev
cp .env.e2e.local.example .env.e2e.local   # no secrets go in it
brew install mailpit                        # only needed for e2e:local
npm run e2e         # against dev.naisi.uk
npm run e2e:local   # everything, against a local server it starts itself
npm run e2e:browser # every browser spec, seeded and torn down per spec
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

And the browser specs (`npm run e2e:browser`), which drive whole journeys in
Chromium rather than posting to a route. `SPEC.status` in each fixture module
is the authority on the last column, and `tests/e2e-coverage-map.test.mjs`
prints every unverified spec on each `npm test`, so this table is a summary
rather than the record.

| Spec | What it protects | Verified | Modes |
| --- | --- | --- | --- |
| `applicant-funnel` | The applicant's whole path: the public course page, the sign-in gate on an apply link, a draft that saves and survives a reload, the availability grid under a real drag, submit, withdraw, pick it back up, the status hub, taking a pre-course seat and leaving it again. | Yes | Both, but 8 of its 13 steps are reCAPTCHA-dependent and run in local mode only |
| `applicant-signup` | Registration end to end: the reCAPTCHA-gated `/api/register`, the emailed magic link driven out of Mailpit, the password set, the university-email verification and the profile completion. | Yes | Local mode only in practice: 8 of its 9 steps are behind the captcha |
| `round-authoring` | An admission round built through the console as the owner: create, stages, roles, status, and the applicant-facing apply page that results. | Yes | Both |
| `appointment-queue` | The decision queue: an application decided by the owner and what the applicant is told afterwards. | Yes | Both |
| `membership-console` | The membership year: periods, the current-period pointer, the roster and a grant. | Yes | Both |
| `member-journey` | What an approved member actually does: approval on the Approvals page, the profile and its notification preferences, the membership read, and enrolling on a course. | Yes | Both |
| `register-push` | The facilitator's register: the roster, marking attendance and pushing it, with the participant notes beside it. | Yes | Both |
| `events-rsvp` | A guest RSVP against a real event, through the public event page to the submitted confirmation. | Yes | Both |

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
leaves, minus the accounts. The browser sign-up spec (`applicant-signup`) drives
the same route and therefore leaves the same `signupMetrics` counters a fraction
higher, for the same reason and with the same excuse: a shared daily counter
cannot be drained without corrupting a real number. It does sweep its
`emailSends` rows, along with its `emailVerifications` tokens, its
`registrations` row, its subscription rows and the account itself, so the
counters are the only thing a run of it leaves behind.

## The browser suite (`npm run e2e:browser`)

Browser-driven runs over whole journeys, so a dress rehearsal is one command
rather than an afternoon of clicking. Different in kind from the batteries
above: those are `fetch()` against routes, these are Chromium driving the
actual pages.

`scripts/run-e2e.mjs` is the runner for all of them. It walks
`scripts/e2e-fixtures/`, seeds each selected spec's world, drives the spec
files, tears every fixture down and proves each manifest reads zero.

**The exact sequence:**

```sh
# one-time, per machine (see "Credentials" above for the gcloud half)
cp .env.e2e.local.example .env.e2e.local
npm install --no-save playwright     # NOT a dependency: see below
npx playwright install chromium

# what it can run
node scripts/run-e2e.mjs --list

# every spec, against the deployed dev backend
npm run e2e:browser

# one spec (or several, comma-separated)
npm run e2e:browser -- --spec applicant-funnel
npm run e2e:funnel                           # the same thing, named

# against a server the run starts itself (captcha relaxed, SMTP on loopback)
npm run e2e:browser -- --local
npm run e2e:browser -- --local --skip-build  # reuse the previous local build

# against a loopback server that is ALREADY RUNNING (somebody else's --local,
# or one started by hand). Nothing is built or started; the reCAPTCHA stub
# still arms, because the origin is loopback.
E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec applicant-funnel

# fewer or more fake applicants (1 to 10, default 5)
npm run e2e:funnel -- --applicants 2

# the applicant-funnel fixture on its own, to click around it by hand
node scripts/seed-fake-applicants.mjs up
node scripts/seed-fake-applicants.mjs status   # the manifest, right now
node scripts/seed-fake-applicants.mjs down     # must end with total: 0
```

**A spec module is one file.** Everything under `scripts/e2e-fixtures/` except
`core.mjs` exports a single object named `SPEC`, and the runner discovers it by
walking the directory, so a new spec is added by adding a file:

```js
export const SPEC = {
  name: "applicant-funnel",                 // unique; state + marker file stem
  specFile: "tests/e2e/applicant-funnel.spec.mjs",
  steps: [...],                             // the spec's step() calls, in order
  recaptchaDependentSteps: [...],           // skipped against a deployed target
  needs: { admin: false },                  // true when it signs in as the owner
  covers: { routes: [...], pages: [...] },  // src/app keys, minus /route.ts or /page.tsx
  status: "verified",                       // "unverified" until it has passed once
  seed: async ({ runId, suppress, options, onState }) => state,
  countRows: async (state) => counts,       // every row and account, plus counts.total
  teardown: async (state) => counts,        // remove everything, then countRows again
};
```

`seed` must call `onState(state)` **before its first write**, and then fill that
same object as it goes. A seed that throws half way is the expensive failure:
an account created, a document refused, no returned state, and a runner that
reports there was nothing to tear down while the rows sit on a shared project.
The published object is the ledger the runner writes and tears down instead.
The guard test fails a fixture module that never mentions `onState`.

A step a spec cannot run in this mode is skipped with `RECAPTCHA_SKIP_REASON`
from `core.mjs`, never with wording of its own: the runner accepts a skip only
when the step is on that spec's `recaptchaDependentSteps` **and** the marker
carries that exact reason, so a gated step that timed out is a shortfall rather
than an accepted gap.

`core.mjs` holds what they share: the collection allowlist and its chokepoint,
`fixtureDoc` / `fixtureQuery` / `fixtureSubcollection` / `membershipConfigDoc`
(the only ways to Firestore), the id restatements, `createFixtureUser`, and the
scratch paths. It does no work at import time, so the guard test can import
every spec module offline to read its `SPEC`.

**Scratch files** live in `.e2e-state/` at the repo root, one
`<spec>.state.json` ledger and one `<spec>.steps.json` completion marker per
spec, with failed-step screenshots in `.e2e-artifacts/`. Both directories are
gitignored, and both are deliberately outside `.next/` (see below).

**A spec that signs in as an admin needs the owner's own account.** This
harness can never create one, by design: the fence forbids writing any role
above `pending`. So `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` go in
`.env.e2e.secrets.local` at the repo root (git-ignored by the `.env*` rule,
never printed, and refused if it carries a service-account key), or in the
shell. The runner checks for them BEFORE it seeds anything and names the file
and the missing variables if they are not there.

**`E2E_SIGNING_SERVICE_ACCOUNT`** overrides the identity custom tokens are
signed as. It defaults to `firebase-adminsdk-fbsvc@naisi-website-dev…`, which
needs `roles/iam.serviceAccountTokenCreator` granted to whoever is running;
a CI workload sets this to its OWN federated service account instead and signs
as itself. It must belong to the dev project, or `env.mjs` throws.

### The applicant funnel (`npm run e2e:funnel`)

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

**A run that drove no browser fails.** Every way a spec can decline to run
(no Playwright, no fixture, a skip) exits `node --test` at 0, which is
indistinguishable from a pass. So the shared recorder in `lib/browser.mjs`
records each step as it finishes, writes the list to
`.e2e-state/<spec>.steps.json`, and the runner deletes that file before the run
and refuses to report success unless it comes back naming every step in
`SPEC.steps`. When it does not, the run exits non-zero with the step it stopped
at.

Both scratch paths (`.e2e-state/`, holding one ledger and one marker per spec,
and `.e2e-artifacts/`) sit at the repo root and are gitignored. They are
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
outside `.next/` by the same guard) before the failure is reported. That, the
step recording and the marker all live in `createStepRecorder`, so every spec
gets them without reimplementing any of it.

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

`scripts/e2e-fixtures/applicant-funnel.mjs` creates, in the dev project (and
`node scripts/seed-fake-applicants.mjs up` is the hand-driven way to ask for
the same thing):

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
Auth account each fixture applicant owns alongside the collections it declares,
so a teardown that stranded either is a non-zero total rather than a clean one,
and a delete it refused (an account whose address is outside the harness
namespace) is recorded in the manifest instead of logged and forgotten.
Teardown runs in a `finally`, leaves the state file in place when anything is
still standing, and an interrupted run says exactly which command clears up
(re-running the same spec, or `node scripts/seed-fake-applicants.mjs down` for
the funnel).

The send log is now part of that. `emailSends` used to be left behind on
purpose; that stance is withdrawn. When the run's mail is caught by Mailpit the
fixture addresses are NOT suppressed, because a spec wants the row a real send
leaves, so the rows are evidence, and evidence a fixture creates is evidence it
counts back to zero. Everywhere else the suppression stays on and there are no
rows to count. Note what that count is keyed on: the funnel counts and sweeps
`emailSends` by the RECIPIENT, which is run-scoped because a fixture address is
`e2e-f<runId><index>@e2e.invalid`. A send this harness causes to somebody else
(a facilitator, an admin, a group notice) is not covered by that key, and a
spec that drives such a route must count it by whatever key it is addressed
with.

### Its own fence, and why it is not inside this directory

`tests/e2e-no-privilege-grants.test.mjs` holds the AUTH harness to three
Firestore collections. The browser fixtures need everything in
`FIXTURE_COLLECTIONS`, far more than three, so they cannot live
inside that fence without tearing it down, and they sit at
`scripts/e2e-fixtures/` with a fence of their own shape, enforced by
`tests/funnel-harness-guards.test.mjs` under `npm test`. That guard WALKS the
harness (`scripts/e2e-fixtures/`, `scripts/run-e2e.mjs`,
`scripts/seed-fake-applicants.mjs`, `tests/e2e/`) rather than listing its
files, and asserts the walk found the four that must always be in it:

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
  must refuse. The grep half then insists Firestore is reachable from
  `core.mjs` and nowhere else: only that file may call `.collection(...)`, and
  only with the checked `collection` parameter of `fixtureDoc` / `fixtureQuery`
  / `fixtureSubcollection`, or the literal `users` (the document each fixture
  account owns, written by the auth harness's guarded seeder and deleted under
  a namespace re-check on the account it belongs to, and counted by the
  manifest so a stranded one shows up). Subcollections have a list of their
  own, `FIXTURE_SUBCOLLECTIONS`, whose value the guard pins so the name cannot
  quietly become something else. `config` is narrower still: only
  `config/membership` is addressable, only through `membershipConfigDoc()`, so
  a membership spec can move the current-period pointer and put it back
  without any fixture going near the scheduler cursors or the task email copy.
- **Every spec module declares what it covers.** The guard imports every
  module in `scripts/e2e-fixtures/`, checks the `SPEC` shape, checks the names
  are unique, checks the step names in the spec file equal `SPEC.steps` in
  order, and resolves every `covers` entry against a walk of `src/app`. A key
  that names no route or page fails with the key printed, rather than being
  skipped.

### It cannot cause real email

The drop-out route emails the member. Fixture addresses are `.invalid`
(RFC 2606, no DNS and no inbox), but against the deployed dev backend that
would still be a real hand-off to Resend and a hard bounce logged against the
sending domain. So seeding writes a `suppressedEmails` row for every fixture
address FIRST unless this run's mail is caught. The rows are ledgered and
removed by teardown like everything else.

The runner passes `suppress: false` only when `mailIsCaught()` in `core.mjs`
says so: a server this run started itself through `run.mjs`, which has forced
the SMTP onto the Mailpit catcher on this machine, or the port reserved for
one (`http://127.0.0.1:3100`). There a send cannot leave the laptop, and the
`emailSends` row it leaves is what a spec reads to prove a route really sent.
Those rows are counted and drained by the manifest.

That decision is a fact about the server, **not** the shape of the origin, and
the difference matters: `http://127.0.0.1:3000` and `http://localhost:3000` are
on the target allowlist too, and they are the ordinary `npm run dev` ports,
whose server reads the real Resend credentials out of `.env.local`. Suppressing
on those is the safe answer, so `mailIsCaught()` is a small exported function
with the guard test pinning both answers rather than an inline `isLoopback`
test that reads right and is wrong.

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

The third way in is `E2E_TARGET=http://127.0.0.1:3100`, with no `--local`:
the runner then starts nothing and drives a loopback server that is already
up. That is how several people (or several agents) share one built server
without each rebuilding `.next`, and the reCAPTCHA stub still arms, because it
keys off the origin rather than off the flag.

## The coverage map

Two guards, both under `npm test`, both offline:

- **`tests/e2e-coverage-map.test.mjs`** walks every `route.ts` and `page.tsx`
  under `src/app` and requires each to be exercised (by a verified `SPEC.covers`
  or by one of the batteries above, named in `AUTH_BATTERIES`) or written down
  in `NOT_COVERED` with a reason and a `coverWhen` trigger. It fails on a
  surface that is neither, on an entry whose key has moved, and on an entry a
  verified spec now covers. A spec whose `status` is `"unverified"` counts for
  nothing and is printed, because a spec that has never passed proves nothing
  about the routes it names. A `coverWhen` has to name an event outside the
  file (a rebuild landing, a cohort starting, a real export arriving), so the
  guard refuses one that recites its own key back: "when a spec drives this
  route" is the gap restating itself, not a trigger.
- **`tests/e2e-test-ids.test.mjs`** matches every `getByTestId("...")` in
  `tests/e2e/` and `scripts/e2e/lib/` against every `data-testid="..."` in
  `src/`, both directions, literals only. A wrapper that takes an id as a
  parameter is declared in `DYNAMIC_LOCATORS`, with the wrapper's name, the
  literal ids it is called with, and the requirement that each of them is still
  asked for literally in the same spec file. The guard reads the wrapper's own
  call sites as well, so handing it an id the entry does not declare fails
  here rather than as a locator timeout in a browser run.

**The burn-down rule**: when a spec starts covering a surface, its keys move
out of `NOT_COVERED` and into that spec's `covers` in the SAME pull request.
The stale-entry check is what makes that compulsory rather than tidy, and it is
the whole reason the map is worth keeping.

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

## In CI

`.github/workflows/checks.yml` runs everything that needs no credentials on
every pull request: typegen, `tsc`, lint, `npm test` (which includes the two
offline fences on this harness, the coverage map and the test-id guard) and a
real build.

`.github/workflows/e2e.yml` is this harness. The owner's decision, September
2026, was yes:

| Job | Trigger | Mode |
| --- | --- | --- |
| `local` | every `pull_request` from a branch in this repository | `npm run e2e:local` (the nine fetch batteries) then `node scripts/run-e2e.mjs --local --skip-build` (the browser specs): builds the app once, boots it on loopback with the always-pass captcha secret and Mailpit, so the reCAPTCHA-dependent legs really run |
| `dev` | nightly at 03:00 UTC, and `workflow_dispatch` | `npm run e2e` then `node scripts/run-e2e.mjs`, both against `https://dev.naisi.uk`: the deployed backend, real secret resolution, real SMTP, real reCAPTCHA, with the gated legs skipped and reported |

**Both halves run, and that is deliberate.** The coverage map credits the fetch
batteries with the registration and magic-link routes (`AUTH_BATTERIES` in
`tests/e2e-coverage-map.test.mjs`), so a CI job that ran only the browser specs
would leave that credit collected by nobody. The batteries go first in the
local job because they build the app; the browser step then reuses that build
with `--skip-build`, and `run.mjs` rebuilds anyway if the values baked in
differ from what it wants.

**Every run of this workflow queues behind the last one.** The concurrency
group is the workflow, not the ref, because every job here drives the SAME dev
Firebase project. Ordinary rows never collide (fixture ids carry the run id),
but `config/membership` is a singleton: the membership spec snapshots that
pointer, borrows it, and restores it in teardown. Two overlapping runs would
restore a pointer to a period the other has already deleted, and both manifests
would still read zero, so the corruption would be invisible to the thing meant
to catch it. That is also why a pull request run and the 03:00 nightly cannot
overlap.

**Credentials are federated, never stored.** GitHub mints an OIDC token for the
workflow, Google exchanges it for one on a dedicated service account bound to
this repository, and the runner ends up with Application Default Credentials in
the same shape a laptop has after `gcloud auth application-default login`. No
key file exists to leak. The workflow signs custom tokens as that same account
(`E2E_SIGNING_SERVICE_ACCOUNT`), so nobody has to grant a CI identity rights
over the shared `firebase-adminsdk` account.

One grant is still needed, and it is the trap written up under "Known gotchas"
in CLAUDE.md: `createCustomToken` signs by asking IAM to `signBlob` as that
account, so the account needs `roles/iam.serviceAccountTokenCreator` **on
itself**. Without it the first spec that mints a session dies with
`Permission 'iam.serviceAccounts.signBlob' denied`, which reads like an
authentication failure and is not one:

```sh
SA=<the GCP_E2E_SERVICE_ACCOUNT address>
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$SA" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=naisi-website-dev
```

**It is `pull_request`, never `pull_request_target`.** `pull_request_target`
would run the base branch's workflow with secrets available while a fork's code
is checked out, which is the standard way to hand a stranger's branch your
credentials. Under `pull_request` a fork gets no id-token at all, so the `local`
job skips fork pull requests explicitly rather than failing them with an
authentication error nobody outside the repository can fix.

**What it expects, and what it does until then.** Both jobs are gated on
`vars.GCP_WORKLOAD_IDENTITY_PROVIDER` being set, so until the federation exists
they skip cleanly rather than going red:

| Setting | Kind | What it is |
| --- | --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | repository variable | The full provider resource name, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `GCP_E2E_SERVICE_ACCOUNT` | repository variable | The dedicated dev-project service account the workflow impersonates and signs tokens as |
| `E2E_ADMIN_EMAIL` | repository secret | The owner's admin account, for the specs that drive an admin-only screen |
| `E2E_ADMIN_PASSWORD` | repository secret | Its password |
| `E2E_UPLOAD_SCREENSHOTS` | repository variable, optional | Set it to `true` while chasing a failure to have the failing step's screenshots uploaded. Off by default, for the reason below |

Neither address is a secret, which is why they are variables: seeing in the log
which identity a run used is worth more than hiding a service account's name.

**The screenshots are opt-in because this repository is public.**
`.e2e-artifacts` holds a full-page screenshot and the page text of the step
that failed, and the admin-driven specs fail on screens (Approvals, Members,
the membership roster, the appointments queue) that render whatever the dev
project holds: real names, real addresses. An artifact on a public repository
can be downloaded by anybody, so the upload waits for
`E2E_UPLOAD_SCREENSHOTS`, and keeps them for a day rather than a week. The
ledgers upload unconditionally: they carry fixture ids and `e2e.invalid`
addresses only.

**A cancelled run is the one bad case.** Teardown runs in a `finally`, so a
failed run still clears up, but a run killed part way leaves its fixture on the
dev project and its ledger in a workspace that is about to be deleted. Hence
`cancel-in-progress: false`, and hence the failure path always uploads
`.e2e-state`: the ledger is what a person needs to tear a stranded fixture down
by hand.

**A green CI run still does not replace the manual dev smoke pass**, for every
reason in "Known holes" above: Chromium only, no Google sign-in, no rules, and
no infrastructure beyond what the specs happen to touch.
