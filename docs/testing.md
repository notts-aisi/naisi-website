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
  none of them, and a `notice` entry must call one of the lane's two doors. The
  matching negative for `notice` is per FILE and not per entry, because two
  files genuinely carry both lanes (`courseFacilitatorEmails.ts`, and the run
  composer route, whose body flag chooses between an opt-outable announcement
  and a notice): a file whose entries are ALL notice must reference no marker at
  all, and a mixed file is registered once per lane instead.
  Each entry also pins `calls`, how many times that file calls
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
- `tests/event-location-disclosure.test.mjs`: an event's exact location
  reaches a person only through `src/lib/events/location.ts`, and only when
  they hold a confirmed place. The helper is executed (a hidden location with
  an empty public label yields a placeholder, never the exact text), the RSVP,
  approve, cancel, broadcast and update routes are executed with the real
  templates rendered to HTML, and every file under `src` that touches the
  three location fields is registered in `SITES` with a role and a reason,
  both directions: a renderer imports the helper and reads none of the fields
  raw, a relay may pass them along but may not branch on `locationHidden`,
  a template takes a finished line, and exactly one file branches.
- `tests/event-rsvp-identity.test.mjs`: the public RSVP route executed as a
  guest, a member, a pending and a rejected account. A signed-out submission
  is answered identically whether or not the address already holds an RSVP,
  files nothing on a duplicate and mails the address instead; a member's
  submission is keyed on the account, so a guest row under their address
  blocks nothing; a decided row is never reset. The tree half:
  `EMAIL_KEYED_DOCS` lists every document id under `src` built from an
  address with the reason a caller cannot turn it into a question, and
  `HASHING_ROUTES` every route handler that hashes anything with what it
  hashes, both checked in both directions with per-file counts.
- `tests/public-client-props.test.mjs`: no Server Component an anonymous
  visitor can render hands a whole document to a client component, because
  React serialises every prop a client component receives into the page's
  HTML whether or not the component renders it. It walks every page and
  layout outside `(app)` and `api`, then every Server Component they reach,
  and fails on a client-component attribute whose value is an identifier the
  file declares as a document (a `…Doc` annotation or an `await get…()`),
  unless the site is in `ALLOWED` with the reason the whole document is
  public. Found on 8 September 2026 on the public event page, where the RSVP
  form received the whole event and the page's HTML carried the exact
  location of a hidden-location event to anybody.
- `tests/authority-at-use.test.mjs`: being named on a document is not a
  standing grant. A dozen documents carry an array of uids that decides what
  the people in it may do (a run's `trackLeadUids`, a round's `reviewerUids`,
  a circulation's `staffUids`, a worksheet's `authorUid`), each written behind
  a bar, and until 9 September 2026 not one of those bars was asked again when
  the authority was used, while nothing anywhere removed a uid from an array
  when the person was demoted, lost SU recognition, or was rejected. Revoking
  somebody's standing revoked nothing. The bar now lives once, in
  `src/lib/firebase/eligibility.ts`, keyed by `collection.field`, with the
  appointment site named per entry; `isNamedWithStanding` asks both halves at
  once and an approved-account floor is applied centrally so a bar written as
  a bare permission test cannot admit a rejected account. The guard walks
  every `.ts` and `.tsx` under `src` for the raw comparison in six shapes
  (`.includes`, `.indexOf`, `===`, the reversed `===`, `array-contains`, and
  a `some`/`find`/`filter` predicate), reading source with comments and
  TypeScript casts stripped so a gate split over four lines still reads as
  one. A hit that is not the helper fails unless `RAW_SITES` says it is a
  client component or not a gate, with a per-file per-field count and a
  reason; an entry may carry `provedBy`, a literal the file must still
  contain, which turns "covered elsewhere in this file" into an assertion.
  Both directions there, and both between the registry and the tree: an
  authority named at a call site must exist (a typo otherwise throws on the
  branch nobody exercises) and an authority nobody calls fails as dead policy.
  Then it executes: the whole persona matrix is written out cell by cell, and
  each bar is checked against the bar its APPOINTMENT applies, by running the
  real `isEligibleAdmissionsReviewer` and `canCirculateWorksheet` and by
  pinning the two roles routes' `ELIGIBLE_ROLES` literal and
  `isLibraryUser()` in `firestore.rules`. The scanner's own patterns are
  exercised on synthetic gates and near-misses, so one that had quietly
  stopped matching fails rather than passes.

  The same file carries the two neighbours of the class, both found by the
  skeptic pass over the first fix rather than by the audit. A PERMISSIONS KEY
  outlives an account the same way a name on a document does, because nothing
  clears the map when somebody is rejected: the floor lives in the nine `can*`
  helpers in `lib/firestore/users.ts`, every one of them executed here against
  every persona, and no route handler or server page may read a raw
  `permissions.<key>` beside them (twenty-seven did). And the RULES say the
  same sentence or the routes are worth nothing, because the browser can read
  the document directly: every helper in `firestore.rules` whose body tests
  `request.auth.uid` against a document field is found by a brace-matched walk
  of the file and must carry a role test, with `NOT_APPOINTMENTS` naming the
  ownership scalars that are excused and why. Both lists are checked in both
  directions.

  The two halves are proved together rather than separately: flipping a rules
  helper changes what `scripts/rules-tests/tests/client-queries.registry.mjs`
  answers for the `pending` persona, so fifteen registry outcomes moved with
  this change and each one had to be written down as a decision.
- `tests/send-recipient-scope.test.mjs`: who the server contacts is the
  server's decision, never a list the caller wrote. Three of the five task send
  routes built their recipient list out of a uid array the caller had written
  on a document the caller owned: `comment.mentions`, which the rules cap at
  twenty entries and constrain nothing else about, and the reviewer arrays on
  `task.subtasks`, which sit in the narrow band every completer may write and
  which a personal task's creator rewrites freely, uncapped. A `member` with a
  to-do they had just created for themselves could have the server deliver a
  NAISI-branded email and a web push with their own subject and body to any uid
  they named. The audit found the first; the other two were found writing this
  guard. The rule now lives once, in `src/lib/tasks/recipientScope.ts`: a task
  notification reaches `completerUids ∪ reviewerUids` and nobody else, which is
  the pool every picker in the product already offered. The guard executes the
  chokepoint and the three routes as a member and as a pending account, and
  walks every file under `src/app/api` and `src/lib` that can send for every
  recipient it names, in five shapes rather than one: a member read, a
  destructured one, one off a call result, a recipient the REQUEST names
  singularly (`body.uid`), and a list the file assembles for itself. The first
  version read one shape and a skeptic listed what it therefore could not see,
  two of which were live and unregistered. `RECIPIENT_SOURCES` says where each
  one comes from: a `gate` on the caller, a server-written `roster`, a
  `caller`-written value with the literal that scopes it, a `derived` value
  naming its source, a `record` of who acted, or a list `assembled` here, which
  must have a registered source in its own file or a written reason why the
  scan cannot see one. Both directions, per-file per-name counts, and the
  claims that a value reaches no recipient are checked against the lines that
  mention it rather than believed. The doors it scans for are shared with the
  classification guard (`tests/lib/sendDoors.mjs`), because this file's own
  copy had three missing and a fourth spelled wrong, so a route that delivers
  web push was never opened at all.
- `tests/deadlines-enforced.test.mjs`: a deadline somebody is told about is
  enforced by the write it bounds. An admission stage's own `closesAt` was
  authored, stored and printed in the announcement email, and no write path
  read it: `effectiveStageClose` had two call sites and both of them only told
  the applicant, so somebody told "Part 2 is due Friday" could file it the
  following Wednesday, and the ordinary form rendered a live submit button
  while they did. The guard asks the tree two questions. Every deadline-shaped
  field in the `src/lib/firestore` normalisers is registered with who it binds,
  where they are told, and either where it is refused past or, in writing, why
  nothing refuses (a task due date is a nudge between colleagues; a scheduler
  lease binds no person). And every function that COMPUTES a deadline has each
  of its call sites classified as telling, enforcing or deriving, both
  directions against the tree, with the sentence that closes the class: a
  predicate with a `tells` site and no `enforces` site fails, which is exactly
  the state `effectiveStageClose` was in. Then it executes the boundary, the
  draft save either side of it, and the later-stage submit one millisecond
  either side of the deadline.
- `tests/public-write-gating.test.mjs`: an endpoint a stranger can drive to a
  side effect is gated like one. The public RSVP wrote an attendee row and
  posted a NAISI-branded email, from the society's own DKIM-aligned sender, to
  an address the caller typed, with no session requirement, no reCAPTCHA and no
  throttle: a harvested list and a loop was a spam run signed by the society,
  and the bounces landed on its own suppression list. The guard decides, per
  exported handler under `src/app/api`, whether an anonymous caller reaches its
  body, and the word that matters is TOP LEVEL: the RSVP route did call
  `getCurrentUser`, and refused a missing session only inside
  `if (visibility === "members")`, so a check that asked whether the file
  mentions a session at all would have called it gated. `PUBLIC_HANDLERS` then
  answers for each one what it does and what gates it, both directions, and
  applies the rule: a handler that SENDS to a caller-chosen address carries a
  rate limit and either a captcha or a per-address cooldown; one that WRITES
  carries a rate limit or a credential the caller presented. Every literal
  named is checked against the file. Two entries are recorded rather than
  blessed and say so: `POST /api/subscriptions` has no captcha, and
  `POST /api/admin/impersonate/exit` has no identity check at all. The runtime
  half, `scripts/e2e/tests/public-write-gating.test.mjs`, asks a deployed
  backend the question a source scan cannot: whether the secret behind the gate
  is actually provisioned there.
- `tests/gate-before-data.test.mjs`: a route proves who is calling before it
  reads or writes anything. `POST /api/verify-email/send` once validated the
  address before it looked for a session (#209), and the audit of 8 September
  2026 found the same shape the other way round on three routes: a document
  read and answered from before the caller's right to know it existed was
  checked. The guard reads every exported handler under `src/app/api` in call
  order and requires the first recognised gate (`GATES`: the session helpers,
  the applicant and staff gates, a signed-token verify, reCAPTCHA, a
  constant-time secret compare, or the SDK's `verifyIdToken`) to come before
  the first Firestore touch. A helper defined in the same file is read the
  same way at the point it is called, so a gate inside `requireEnroller()` or
  `keyAccepted()` counts where the wrapper is called and a read inside one is
  a touch where it is called. Everything imported from the repository that
  runs before the gate must be in `PURE`, and the claim is checked against the
  function's own body; a package import is not classified because it cannot
  reach this app's Firestore without the handle. When the gate is a session
  gate, the handler's top-level refusal of a missing session must precede the
  first touch as well. `PUBLIC` lists the five handlers with no gate before
  their first touch (the calendar feed, the resend and subscribe routes, the
  session clear, and the view-as exit, which is recorded rather than blessed),
  each with the literal that stands in for the gate, and
  `TOUCHES_BEFORE_GATE` the one handler that writes an aggregate counter ahead
  of its captcha on purpose. Every list is checked both ways and the scanner's
  reading is exercised on synthetic handlers. It shares its reading of a route
  file with the public-write guard through `tests/lib/routeScan.mjs`.
- `tests/response-projection.test.mjs`: no whole document reaches a response
  without a projection that names its reader. A normaliser produces the shape
  the server works with, every field typed, and the audit of 8 September 2026
  found the admissions rounds list handing that shape to any `draftCourse`
  holder: the scoreboard, the deciding uids and the criteria that the
  applicant projection is written to withhold. The guard reads every
  `NextResponse.json(...)` under `src/app/api` as a value or as an object
  literal's values, and a value is raw when it is `.data()`, a normaliser
  call, a `.map` whose callback produces one of those (the callback's RETURN is
  what is read, so an inline hand-picked object is a projection and a spread
  of the document is not), an identifier bound to any of those in the
  enclosing function (the binding's whole expression, with the last `.map` in
  the chain deciding), a spread of one, or a ternary with such a branch. A raw
  value must pass through a name in `PROJECTIONS`, the registry of projection
  functions with the persona each serves and what it withholds, or sit in
  `ALLOWED` with the reason the whole document is the right answer for that
  persona (one entry today: the course page editor echoing the page its author
  just saved). Both directions on both lists, the projection's module is
  checked against every route that imports it, and a reverse walk over
  `src/lib` and `src/features` requires every export named like a projection
  to be in `PROJECTIONS` or in `PROJECTIONS_ELSEWHERE` with where it is
  applied instead. What it cannot see, and says so: a document that reaches
  the response through a helper in another module, and a single field of one.
  The `serialiseRound` entry records rather than resolves the draftCourse
  admission, which is documented intent and the audit's open low finding.
- `tests/lib/stripSource.mjs`, proved by the guards that use it: reading a
  TypeScript file as code is done once, by a tokeniser, rather than by four
  regexes per guard. The four-regex version desyncs on a trailing comment with
  an apostrophe in it: `// don't` survives the whole-line rule and the
  single-quote pass then swallows everything to the next apostrophe. On
  `src/app/api/unsubscribe/route.ts` that turned a 15,837 character file into
  4,705 and made both of its handlers invisible, which a scanner reports as
  nothing to see rather than as a failure. `assertReadable` is the standing
  answer to the cases a tokeniser still cannot parse: a caller asks whether the
  result is plausible for its input, and a collapse fails loudly.
- `tests/lib/outputGuard.mjs`, loaded into every `npm test` process by the
  `--import` flag on the test script and proved by
  `tests/output-lines.test.mjs`: no test process may print a line over 20 KB.
  The loader turns every module under test into a `data:` URL, so a stack
  frame printed by code under test carries a whole module graph and one line
  runs to 440 KB, which GitHub's runner handles a line at a time and stalls
  on for minutes (30 of a 33-minute job on 2026-09-06). A test that drives a
  failure path the code is expected to log mutes that method for its own
  duration with `t.mock.method(console, "error", () => {})` (or `"warn"`); the
  CI job keeps its `cut` as the backstop.

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
- **A spec acts through Playwright's actionable methods and never through
  coordinates it measured.** `click`, `fill`, `press`, `hover`, `dragTo` and
  `scrollIntoViewIfNeeded` check that the target is what the pointer will hit
  immediately before acting, and retry; a spec that reads a box and moves the
  mouse itself is racing the page between the two. `tests/e2e-interaction-guard.test.mjs`
  fails raw mouse coordinates, `elementFromPoint`, `getBoundingClientRect`,
  hand scrolling, `dispatchEvent` and fixed sleeps in a spec; measurement that
  only asserts is allowlisted with its reason. Anything geometric a spec
  really needs is a helper in `scripts/e2e/lib/browser.mjs` with its own
  diagnostics. A failing step saves a trace beside its screenshot, so read
  the trace before adding a wait: see "Diagnosing a failing step" in
  `scripts/e2e/README.md`.
- **The guards run under `npm test`**, with no browser and no credentials:
  `tests/funnel-harness-guards.test.mjs` (the fence and the SPEC contract),
  `tests/e2e-coverage-map.test.mjs` (the map below) and
  `tests/e2e-interaction-guard.test.mjs` (the rule above).

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
reCAPTCHA-dependent legs skipped and reported). The nightly checks out `dev`,
the branch that target deploys from, rather than the default branch a schedule
starts on; a dispatch keeps the ref it is given. Credentials come from Workload
Identity Federation rather than a stored key, the trigger is `pull_request` and
never `pull_request_target`, both jobs skip cleanly until the federation
variables exist, and every run of the workflow queues behind the last because
they share one dev Firebase project. The settings it expects, the IAM grant
custom tokens need, and why the failure screenshots are opt-in are in
`scripts/e2e/README.md`.
