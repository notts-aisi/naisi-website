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
npm run lint            # 0 errors; the warning baseline on dev is 32
npm test                # the Node suites under tests/
cd scripts/rules-tests && npm test   # the emulator suite; Java required
npm run build           # a real production build
```

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
