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

**`storage.rules.test.mjs`** → see `tests/storage.test.mjs` — the second,
separately-deployed rulebook, which has already broken production once
(`ce8f140`: a missing `event-images/` block hit deny-by-default, because
Storage rules need their own `firebase deploy --only storage` and nothing
verifies the deployed set matches the repo). Two findings recorded as
executable characterisations:

- **A non-SU committee member reaches task attachments they are denied in
  Firestore.** `firestore.rules` gates committee tasks on `isSuCommittee()`
  (`role == 'committee'` **and** `suRecognised == true`); `storage.rules` checks
  only `role in ['committee','admin']` and contains no `suRecognised` anywhere.
  So the task *document* is denied while its attachment *blobs* are not — and
  the file's own comment claims it "mirrors the Firestore task access gate".
- **`image/.*` admits `image/svg+xml` onto the two `allow read: if true`
  paths.** Exploiting it needs drafter/approver permission, and whether the SVG
  executes depends on the download URL's serving headers, which rules cannot
  express — so this is recorded, not rated.

Plus a **drift check**: `application-emails/…`, the path the email-design
editor actually uploads to, has no committed rule and is asserted denied. If
that feature works in production while this test passes, the deployed ruleset
is a superset of the repo.

Refuted while writing these: the concern that `text/.*` (which matches
`text/html`) sits on a public path. It does not — `text/.*` is confined to
`tasks/`, which requires authentication.

## Gotchas that cost real time

- **Any test touching Storage must use the namespace `"test"`.**
  `storage.rules` resolves its `firestore.get()` lookups against the project
  the *emulator* was started with, not the one the client connects as. With a
  mismatched namespace, every role lookup silently returns nothing: all
  "should be allowed" tests fail with `storage/unauthorized` while all "should
  be denied" tests pass. That asymmetry is the tell.
- **Test files run in parallel processes.** Each Firestore-only file gets its
  own project id, because a shared one lets one file's `clearFirestore()` wipe
  another's fixtures mid-test — observed as a suite that passed, failed once,
  then passed again.
- **`seedUser()` reads the document back before returning**, because a test
  that uploaded immediately after seeding failed roughly once in fourteen runs.
  If a flake reappears in the Storage suite, start there.

## What this does not cover

Email template rendering (Mailpit, Phase 4 of the e2e brief) and the
reCAPTCHA-gated `/api/register` front door (Phase 3), which needs a local
captcha-relaxed server.
