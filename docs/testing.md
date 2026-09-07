# Testing model

How this repo decides what to test, and why the answer changed in September
2026. The short version lives in CLAUDE.md under "Testing model"; this is the
long version, with the worked examples.

## The bugs lived in the seams

Until this month every check inspected one layer at a time. `tsc` proved the
types. `eslint` proved the style. `npm test` proved the functions. The rules
suite under `scripts/rules-tests/` proved what `firestore.rules` allows. Each
was green, and the bugs that reached production lived between them:

- **A client query whose shape did not satisfy its rule.** The `/profile`
  subscriptions listener carried one clause (`audienceId`) when the rule needs
  two (`audience` and `audienceId`). Firestore judges a `list` or a `listen` on
  the query's shape, not on the rows it returns, so the whole listen was
  refused for every non-admin, silently, with an empty grid and no error
  anybody saw. It was live on production from 6 May to 3 September 2026 and
  was fixed in #261. The rules suite could not see it (the rule was right) and
  no unit test could see it (the query was syntactically fine).
- **A query with no declared index.** The account-deletion sweep of membership
  import rows is a collection-group query on `matchedUid`, which needs a
  COLLECTION_GROUP-scoped index that `firestore.indexes.json` did not declare.
  The Firestore emulator does not enforce indexes, so every suite passed and
  the query would have thrown FAILED_PRECONDITION the first time it ran for
  real.
- **A client module reaching a server-only one.** A `"use client"` component
  imported a nine-line helper that, four modules down, reached a file carrying
  `import "server-only"`. Typecheck, lint and the unit suite were all green on
  twenty-seven branches; the first production build failed with four errors,
  because Next enforces that boundary only when it bundles.

None of these is a bug in one layer. Each is two correct layers that do not
agree. So the tests that catch them have to hold two layers together, and we
call those tests guards.

## The guards, by path

A guard walks the tree, enumerates every site of a given kind, and checks each
one against the other layer. Where a site cannot be resolved from source it is
reported and must be declared, never skipped. The three built this month are
the worked examples; the family they join is listed after them.

### `scripts/rules-tests/tests/client-queries.test.mjs`

Client query versus Firestore rule, run in the emulator suite. Its data lives
beside it in `client-queries.registry.mjs`.

- **Enumerates** every read issued through the client SDK: every file under
  `src` importing from `firebase/firestore`, and in each one every `getDocs`,
  `getDocsFromServer`, `getDoc`, `getCountFromServer`,
  `getAggregateFromServer`, `onSnapshot` and transaction read. For each
  site it resolves the collection path (string literals, string constants and
  object constants such as `SITE_NOTICE_PATH.collection`) and the clause
  shape: each `where` as a field and operator, each `orderBy` as a field and
  direction, `limit` as present. Values are treated as dynamic.
- **The registry** has one entry per distinct (file, path, clause set). Each
  entry states the gate the calling page sits behind, an outcome (`allowed` or
  `refused`) for every base persona, optional outcomes for the `permissions`
  variants, a `seed` hook for the fixture the rule needs, and the executable
  form the test runs. Matching is bidirectional: a read with no entry fails
  naming its file, line and shape; an entry matching no read fails as stale.
  A read the scanner cannot resolve (the spread constraints in `useTasks`, the
  ternary reference in `useWeek`) fails unless an entry declares the shapes it
  can take, pins the literal call site each shape was read from, and states
  how many unreadable reads the file carries.
- **Executes** every entry against the emulator as every persona it names
  (signed-out, pending, member, non-SU committee, SU committee, admin, plus
  the permission variants) and asserts the stated outcome. A refusal for a
  persona who can reach the page is a finding to raise, not a line to write
  down.
- **Named regression cases** pin the three shape bugs and the registration
  reads, which run as an account with no `users` document yet.

### `tests/firestore-indexes.test.mjs`

Query versus declared index, a Node suite with no emulator and no credentials.

- **Enumerates** every query in `src` and `scripts` (excluding
  `scripts/rules-tests`, which only ever runs against the emulator): Admin SDK
  chains rooted at `.collection()` or `.collectionGroup()`, including chains
  that span lines, grow through a variable, sit inside `countAgg(...)` or a
  transaction, or come through the seed script's `fixtureQuery` wrapper; and
  the client `query(collection(...), where(...), orderBy(...))` form. It
  captures the collection or group, each filter's field and operator, and each
  sort field and direction.
- **Encodes Firestore's index rules** as a table, each entry quoting the
  documentation sentence it came from. Five of them were also settled by
  read-only probes against the dev project: equality-only queries merge the
  automatic single-field indexes, array-contains merges the same way, a
  trailing `orderBy(__name__)` is served by the automatic index in either
  direction, an index is never scanned in reverse, and the required field
  order is equalities, then the explicit sort fields, then any inequality
  field the sort does not name (which is also why a longer index does not
  serve a shorter query).
- **The registries** cover the four sites the scanner cannot read: three
  whose collection or filter field is a variable (`UNRESOLVED_SITES`) and one
  whose constraint list is spread from arguments (`SPREAD_SITES`), plus the
  one wrapper (`COLLECTION_WRAPPERS`) and the queries known to be missing an
  index (`KNOWN_MISSING_INDEXES`). Every list of query sites is checked both
  ways: an unregistered site fails, and an entry matching nothing fails.
  `COLLECTION_WRAPPERS` names a helper rather than a site, so it is checked
  only for a written reason.
- **Fails** on a query that needs an index and has none, printing file, line,
  shape, rule and the JSON stanza to paste. **Warns** on a declared index no
  query uses. `FIRESTORE_INDEXES_PATH` points it at a different index file,
  which is how the negative control runs without touching the real one.

### `tests/client-server-boundary.test.mjs`

Client module versus server-only module.

- **Enumerates** every file under `src` that begins with `"use client"`, then
  walks the real import graph from each one (relative and `@/` specifiers,
  static and dynamic, value imports only: a type-only import is erased by
  TypeScript and carries nothing into the bundle) and fails naming the whole
  chain if any reached module imports `server-only`. Today that is roughly
  four hundred and fifty client files and four thousand edges.

### The wider family

The same shape, older:

- `tests/no-admin-gating.test.mjs`: every page under `src/app/(app)/admin`
  sits inside one of the four gated route trees (`(admin-only)`, `courses`,
  `admissions`, `membership`), and each tree's layout still calls its gate. A
  page dropped straight into the admin directory fails.
- `tests/impersonation-guard.test.mjs`: every mutating route under the
  guarded API trees calls `assertNotImpersonating()` at its top. `MUST_GUARD`
  lists the routes with the reason each is high-trust; a new mutating route
  in a guarded tree fails until it calls the guard or lands in `ALLOWLIST`
  with a reason.
- `tests/courses-draft-reads.test.mjs`: only the files in `ALLOWED` touch
  `courses` or `courseRuns` client-direct, read or write, each with the gate
  it sits behind.
- `tests/e2e-no-privilege-grants.test.mjs` and
  `tests/funnel-harness-guards.test.mjs`: the two end-to-end harnesses can
  never be aimed at production, never grant a role or permission, and only
  address the Firestore collections on their own declared lists.
- `tests/notification-classification.test.mjs`: every send in `src` declares
  which of the three notification classes it belongs to. The scanner walks the
  tree for calls to `sendEmail`, the two push mirrors and every named wrapper
  (`sendRsvpEmail`, `notifyWorksheetEvent`, the admission and nudge wrappers,
  and the rest, enumerated rather than remembered); `REGISTRY` maps each
  `file#symbol` to `grid` with its row, `transactional`, or `notice`, with a
  written reason. Both directions, and the class is read out of the source
  rather than believed: a `grid` entry's file (or the file its `via` names,
  for a sender that delegates) must reference one of the five markers that
  resolve a row, a file whose entries are all `transactional` must reference
  none of them, and a `notice` entry must call the notice helper and must not
  consult the grid. Each entry also pins `calls`, how many times that file calls
  that symbol, so a second send dropped into a file the registry already names
  fails instead of folding into the entry above it. The markers are themselves
  checked to reach `resolveRow`, so a sixth way of reading a preference cannot
  appear that compares a stored value to `false` by hand; `TRACKED`, the
  scanner's whole reach, is checked against the tree in both directions, so an
  exported wrapper with callers that nobody added to it fails rather than
  removing its call sites from the registry; and the scanner's own regex is
  exercised on synthetic call sites, definitions, comments and property
  accesses so a guard that had quietly stopped matching would fail rather than
  pass.
- `tests/pwa-offline-assets.test.mjs`: the service worker's write-nothing
  contract.

### What every registry and allowlist has in common

- It is written out in full, so it reads as a list of decisions and a
  deletion shows up as a diff.
- Every entry carries a written reason, and in most of the lists the test
  checks the reason is real text rather than a placeholder. The two
  exceptions are `MUST_GUARD` and `GATED_TREES`, whose reasons are printed in
  the failure message but not length-checked.
- Every list of sites is checked in both directions. A site with no entry
  fails; an entry with no site fails. A list that can only grow is a list
  nobody trusts. (`COLLECTION_WRAPPERS` in the index guard is the one
  exception: it names a helper, and only its reason is checked.)
- A site the scanner cannot read is reported, never skipped. Silence is the
  failure mode these tests exist to remove.
- A "refused" or "missing" that is reachable in the product is recorded as a
  finding with its reason and left visible. `KNOWN_MISSING_INDEXES` in the
  index guard is the current example: two real missing indexes, each entry
  checked both ways, so declaring the index fails the test until the entry is
  deleted.

## Review detects, guards enforce

A review, or an incident, is how a new class of failure is found. It is not
how the class is kept out. When one turns up, the fix lands with a guard for
the class in the same pull request: the instance is fixed and the tree is
walked for every other instance, present and future. Fixing the instance
without the guard is the thing not to do, because the next instance arrives
with the next feature and nobody is reviewing for a class they have already
forgotten.

## Guards enumerate the tree

A test that covers only the bug you found is a regression test. It is worth
having, and the guards above each carry named regression cases. But it does
not change the odds, because it points at one file. A guard walks every
route, every query or every client file, so new work is covered without
anyone remembering that the guard exists. That is the difference between the
`ProfileForm` pin in the client-queries suite (one query, one clause) and the
scan around it (every client read in the repo, every persona).

## What every change runs

Locally before a pull request, and in CI on every pull request
(`.github/workflows/checks.yml`):

```sh
npx next typegen && npx tsc --noEmit
npm run lint            # 0 errors; the warning baseline on dev is 9
npm test                # the Node suites under tests/
cd scripts/rules-tests && npm test   # the emulator suite; Java required
npm run build           # a real production build
```

The warning count is 9 on a clean checkout of `dev`. A working copy with
skip-worktree overrides in it (`src/lib/devBypass/local.ts`, and anything else
a developer keeps modified locally) reports more: this machine shows 32. Count
the warnings on a fresh clone before treating a number as a regression.

The build is not optional and is not a formality. Next enforces the client
and server boundary only when it bundles, so a tree that is green on
everything else can still be undeployable, and before the workflow existed
that was discovered by a failed rollout.

Two local traps, neither of which exists in CI: a stale `.next/dev/types`
directory left by an old `next dev` session is included by `tsconfig.json`
and breaks `tsc` with route types that no longer exist; and a skip-worktree
override of `src/lib/devBypass/local.ts` whose permissions snapshot has
fallen behind the type fails both `tsc` and the build's type check. When the
main checkout is in that state, a detached `git worktree` with node_modules
copied in (`cp -Rc`, because Turbopack refuses a symlinked node_modules) is a
faithful stand-in for CI.

## Test as a member, never only as an admin

Admins take a different branch of nearly every rule in `firestore.rules`, and
that branch is resource-independent: it matches the whole collection whatever
the query's shape. So a surface tested only as an admin proves nothing about
what a member sees, by construction, and the subscriptions listener stayed
broken for four months precisely because the people testing it were admins.
Every guard that executes a query runs it as every persona, and every manual
check of a member-facing surface is done through a member account or the
admin "view as" tool.

## End-to-end suite

The end-to-end suite is built to cover the surfaces that lose an intake or a
member if they break silently. Its coverage map (which lands with the suite;
until then `scripts/e2e/README.md` lists the known holes with reasons but no
triggers) lists every uncovered surface with a reason and a trigger for when
it gets covered, and the intent is full coverage over time, in risk order. A
change to a covered surface updates its spec in the same pull request.

### Running it

```sh
npm install --no-save playwright && npx playwright install chromium   # once

npm run e2e:browser                     # every spec, against the deployed dev backend
npm run e2e:browser -- --local          # against a server the run builds and starts
npm run e2e:browser -- --local --skip-build      # reuse the previous local build
npm run e2e:browser -- --spec applicant-funnel   # one spec, or several, comma-separated
node scripts/run-e2e.mjs --list         # what it can run

# against a loopback server that is ALREADY running (somebody else's --local
# run, or one started by hand). Nothing is built or started, and the reCAPTCHA
# stub still arms, because it keys off the origin rather than off the flag.
E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec applicant-funnel
```

`scripts/run-e2e.mjs` walks `scripts/e2e-fixtures/`, seeds each selected spec's
throwaway world on the dev project, drives the spec files in Chromium, tears
every fixture down in a `finally`, and exits non-zero unless the tests passed
AND every teardown manifest reads zero. Both facts, because a green suite that
left rows behind has polluted a shared environment. Prerequisites, the fence
around what it may touch and the hand-driven fixture CLI are in
`scripts/e2e/README.md`.

### What a run proves, and what it does not

- **Chromium only.** This repo has already shipped a Safari-only defect (a
  `<button>` whose inline background WebKit painted over), so a green run is a
  regression net and never a substitute for the manual Safari pass before `dev`
  goes to `main`. Google sign-in is not automatable at all, by design.
- **The reCAPTCHA-dependent legs run against dev only through the harness
  bypass.** Google's real widget answers headless Chromium with an image
  challenge, which no spec may solve. Each spec declares those steps in
  `recaptchaDependentSteps`. With no bypass secret the runner accepts exactly
  that set as skipped, only against a deployed target, and only when the
  marker carries the shared `RECAPTCHA_SKIP_REASON`; any other skip is a
  shortfall and fails the run. With `E2E_RECAPTCHA_BYPASS_SECRET` in the
  secrets file the specs send the bypass header with a tokenless request and
  every step must run. The gate (`src/lib/recaptcha/bypass.ts`) grants only
  when the dev backend holds the same variable, the header matches and the
  acting identity is a harness address; a token that is present is always
  verified with Google, and `tests/recaptcha-bypass.test.mjs` keeps the
  variable out of `apphosting.yaml` and the bypass out of the verifier.
- **A pinned defect is a defect, not a passing feature.** The funnel pinned
  one: the public course page's second `CourseCTA` went on offering "Take this
  place" after a member had left the course, because the hero and foot
  placements each mounted their own `GroupPicker` with their own state and the
  foot one never learnt about the drop-out. The assertion said to delete itself
  once the page mounted one picker, that fix landed (the foot now links up to
  the hero's picker), and the same line asserts the corrected behaviour. The
  rule generalises: a real defect a spec finds is pinned with the fix's own
  instructions, never silently fixed or silently worked around, and the fix
  deletes the pin in the same change.
- **A policy version shipping stops nothing.** On a production build the
  member area sends a signed-in account whose stored policy version is behind
  the current one to `/re-consent` before it renders a page, which after a
  bump includes the owner-made admin account every admin spec signs in as.
  The shared sign-in helper presses the real Accept button when the handoff
  lands there and waits for the page to take the browser home, so the account
  is current by its own acceptance and no console edit is ever the fix.
  Member-journey seeds its member as a legacy account (no version on the
  document) so the gate, the consent page and `/api/account/reconsent` are
  driven on every production run, not only the first after a bump; and
  `tests/funnel-harness-guards.test.mjs` fails on a `policyVersion` key
  written anywhere in the harness but the seed of a harness-created account.
- **A cancelled run cleans up after itself.** Both CI jobs end with a step
  that runs `if: always()` and tears down whatever the fixture ledgers still
  name (`node scripts/run-e2e.mjs --teardown`), because a cancelled runner is
  killed before the runner's own `finally` finishes. When the ledgers are gone
  too, `--sweep <runId,...>` removes a run's rows and accounts by the run id
  every fixture row embeds. Never cancel a dev-mode run without one of the two.
- **A spec that reads its own mail runs only where the mail is caught.** The
  suite's no-real-mail promise is that every fixture address is suppressed
  before anything is seeded, which is a promise because `sendEmail()` consults
  the suppression list for every caller and logs an `emailSends` row at status
  `suppressed` for each address it drops. It did not, until the sign-up spec's
  fixture said so out loud and the check moved into the one send function;
  `tests/email-suppression-chokepoint.test.mjs` is the guard that keeps it
  there and proves it by execution as well as by source. Suppression is the
  wrong instrument for a journey that has to CLICK an emailed link, though, so
  such a spec declares `requiresCaughtMail: true` and the runner skips it,
  saying why, wherever `mailIsCaught()` is false.
- **Nothing here proves infrastructure or `firestore.rules`.** The harness
  seeds through the Admin SDK, which bypasses rules entirely; rules belong to
  the emulator suite in `scripts/rules-tests/`.

### Adding a spec

One file under `scripts/e2e-fixtures/` exporting one `SPEC`, and one spec file
under `tests/e2e/`. The runner discovers it by walking the directory, so
nothing else has to be edited.

```js
export const SPEC = {
  name, specFile, steps, recaptchaDependentSteps,
  needs: { admin },                        // true when it signs in as the owner
  requiresCaughtMail: true,                // optional; skipped where mail is not caught
  covers: { routes: [...], pages: [...] }, // src/app keys, minus /route.ts or /page.tsx
  status: "verified" | "unverified",       // see below
  seed: async ({ runId, suppress, options, onState }) => state,
  countRows: async (state) => counts,      // every row and account, plus counts.total
  teardown: async (state) => counts,       // remove everything, then countRows again
};
```

The rules the guards enforce, each because of a way a run can lie:

- **Fixtures reach Firestore through `core.mjs` and nowhere else.**
  `fixtureDoc`, `fixtureQuery`, `fixtureSubcollection` and
  `membershipConfigDoc` check the collection against `FIXTURE_COLLECTIONS`
  before any credential is obtained. Accounts come from `createFixtureUser`,
  which writes role `pending` and nothing above it.
- **The drain list is the manifest's honesty.** Every collection a seed writes
  or a driven route creates is on `FIXTURE_COLLECTIONS` and is counted by
  `countRows`. A collection nobody counted is a manifest that reads zero
  because it looked in the wrong place, so enumerate what a route writes by
  reading the route and every helper it imports.
- **`seed` calls `onState(state)` before its first write**, then fills that
  same object. A seed that throws half way otherwise leaves accounts and rows
  with no ledger naming them.
- **`teardown` asserts `isHarnessAccount` on every address in the state file
  before it deletes anything**, then removes route-created leaves, then the
  fixture objects, then the accounts.
- **Test ids are literal on both sides.** A spec asks by
  `page.getByTestId("area-thing")` and a component carries
  `data-testid="area-thing"`, kebab-case, no template literals.
  `tests/e2e-test-ids.test.mjs` fails an id asked for and not carried, an id
  carried and not asked for, and a computed id on either side. The one
  exception is a wrapper that takes an id as a parameter (counting a picker to
  two, measuring one control): declare it in `DYNAMIC_LOCATORS` with the
  wrapper's name and the literal ids it is called with, each of which must
  still appear literally somewhere in the same spec file. The guard reads the
  wrapper's own call sites too, so an id handed to it that the entry does not
  declare fails here rather than as a locator timeout in a browser run.
- **The two guards run under `npm test`**, with no browser and no credentials:
  `tests/funnel-harness-guards.test.mjs` (the fence and the SPEC contract) and
  `tests/e2e-coverage-map.test.mjs` (the map below).

### The status field, and burning down the allowlist

`SPEC.status` is `"unverified"` until the spec has passed end to end at least
once with a teardown manifest of zero, and `"verified"` afterwards. The
coverage map counts the covers of verified specs ONLY. An unverified spec
contributes nothing and is printed on every run as "spec written, never run",
because a spec that has never passed proves nothing about the routes it names,
and a map that counted intentions would be wrong in the direction nobody
checks.

`tests/e2e-coverage-map.test.mjs` walks every `route.ts` and `page.tsx` under
`src/app` and requires each one to be either exercised (by a verified spec's
`covers`, or by one of the fetch batteries in `AUTH_BATTERIES`) or written down
in `NOT_COVERED` with a reason and a `coverWhen` trigger. It fails on a surface
that is neither, on an entry whose key no longer exists, and on an entry a
verified spec now covers.

So the burn-down is one move: when a spec starts covering a surface, its keys
move out of `NOT_COVERED` and into that spec's `covers` **in the same pull
request**. The stale-entry check is what makes the move compulsory rather than
tidy.

A `coverWhen` names an event outside the file: a rebuild landing, a cohort
starting, a real export arriving, the risk-ordered list reaching that group.
"When a spec drives this route" is not a trigger, it is the gap restating
itself, so the guard refuses a trigger that recites its own key back.

### In CI

`.github/workflows/e2e.yml` runs the suite in both modes: a `local` job on
every pull request from a branch in this repository (the fetch batteries, then
the browser specs, against a server the job builds and boots with the captcha
relaxed and mail caught by Mailpit), and a `dev` job nightly at 03:00 UTC and
on demand (both halves against the deployed dev backend, with the
reCAPTCHA-dependent legs skipped and reported). Credentials come from Workload
Identity Federation rather than a stored key, the trigger is `pull_request` and
never `pull_request_target`, both jobs skip cleanly until the federation
variables exist, and every run of the workflow queues behind the last because
they share one dev Firebase project. The settings it expects, the IAM grant
custom tokens need, and why the failure screenshots are opt-in are in
`scripts/e2e/README.md`.
