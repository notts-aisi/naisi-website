# Firestore rules tests

Executable tests for `firestore.rules`, run against the local Firestore
emulator. Offline, no credentials, cannot reach dev or production.

```sh
cd scripts/rules-tests
npm install     # first time only
npm test
```

Requires a Java runtime for the emulator (`brew install --cask temurin`).

## Why this is a separate package

`@firebase/rules-unit-testing` and `firebase-tools` are **not** in the root
`package.json` on purpose. App Hosting's Cloud Build runs `npm ci` **with
devDependencies** on the critical path of every production deploy, so a heavy
test-only dependency there is a deploy-time liability. Nothing in this
directory ships.

## Why it exists

`firestore.rules` is the layer that *contained* the PR #209 damage, and it is
world-readable in a public repo. Until this suite, every rule change was
unverifiable except by clicking through the Firebase console — and the e2e
harness in `scripts/e2e/` deliberately leaves rules at 0% coverage, because it
seeds through the Admin SDK, which bypasses rules entirely.

**The Auth emulator is permanently out of scope.**
`FIREBASE_AUTH_EMULATOR_HOST` makes firebase-admin verify JWTs with
`algorithms: ['none']`, and `/api/auth/session` calls `verifyIdToken` on an
attacker-supplied request-body field — one stray env var on any backend would
mint a session for any uid, including an admin's.
`@firebase/rules-unit-testing` fakes auth tokens in-process with no emulator at
all, which is what makes this safe. Firestore emulator only.

## What the suites cover

**`candidate-findings.test.mjs`** — three rule gaps raised by an earlier
security pass, now proven rather than suspected. **These tests assert that the
exploits currently SUCCEED**, so they are written to fail the day a rule is
tightened. That is deliberate: when you fix one, invert the assertion in the
same commit.

| # | Gap | Proven consequence |
| --- | --- | --- |
| 1 | Events update rule is not scoped per document, and tests only the *incoming* status | A `member` holding `draftEvent` can self-approve their own event (defeating two-person review) and can cancel **someone else's published event** |
| 2 | Activity-log `create` omits the `canAccessParent()` check its siblings use | Any signed-in account — including a brand-new `pending` one — writes arbitrary text into a task it **cannot even read**, and into task ids that do not exist |
| 3 | `policyVersion` / `policyAgreedAt` appear nowhere in the rules, and there is no `keys().hasOnly()` | A member skips the re-consent gate **and forges their own consent audit record** — the UK GDPR-relevant half |

Each has a passing control alongside it, so a green run is not just "everything
is permitted": a plain member with no permissions is still blocked, sibling
subcollections *do* gate on the parent (which is what makes #2 an oversight
rather than a design), and self-granting `role` / `suRecognised` still fails.

**`public-config.test.mjs`** — the two world-readable collections behind the
site-notice feature. Asserts the notice is readable signed-out, that **nobody**
can write either collection from a client (admins included — all writes go
through `/api/admin/site-notice` on the Admin SDK), that `publicConfig` is
pinned to its single doc id so `list` cannot enumerate a future doc dropped
beside it, and that `config/siteNoticeAudit` — which records *who* flipped the
notice — stays unreadable.

Also included: a regression guard proving PR #216's `uniEmailVerifiedAt` fix
holds, including that a stamp cannot be carried across a university-email
change. The first attempt at that fix guarded the stamp but not its binding to
the address, and only an adversarial second pass caught it.

## What this does not cover

Storage rules. `storage.rules` has the same zero-coverage problem and the same
emulator is available for it — a natural next addition.
