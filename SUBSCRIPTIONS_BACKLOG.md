# Subscriptions and Auth backlog

Remaining work after the subscriptions overhaul. Snapshot taken 2026-05-20.

## Shipped (context)

- #112 to #117: subscription schema split into `confirmed` + `subscribed`, per-(email, channel) writes, recipient-grouped admin UI, cascade-delete on user delete.
- #118 to #123: spreadsheet admin table, inbox-ownership consent gate, `subscriptionEvents` audit log, history cap, guest-subscriber deletion.
- #125: duplicate university-email registration blocked.

All of the above is live on dev and main.

## Remaining work

### Firestore security lockdown follow-ups

Context: the `users`-collection lockdown PR closed the enumeration hole (the
`users` read rule went from `if isSignedIn()` to SU-committee + admin + self),
fixed a privilege-escalation hole on `users` create, locked down `bookings`
client writes, and introduced the `suRecognised` flag splitting SU-recognised
committee from non-SU committee. Remaining items:

- **My Work reviewer merge.** `useTasks` filters by `completerUids` only, and
  its own comment flags this. A non-SU committee member added to a task as a
  reviewer can collaborate once inside the task but cannot discover it from a
  list (it never appears on `/tasks`). Add a second `reviewerUids array-contains`
  query and merge. Needed before non-SU committee are routinely used as
  reviewers.
- **`credentials` access decision.** Still `read/write: hasRole(['committee',
  'admin'])`, so non-SU committee can read shared committee credentials.
  Different sensitivity from member PII (operational secrets, not personal
  data), so it was left as-is. Decide whether non-SU committee should keep
  credentials access; if not, gate it on `isSuCommittee()` too.
- **SU-committee member directory (future).** SU committee currently have no
  in-app screen that shows member PII (the admin pages are admin-gated). When a
  committee-facing member view is wanted, build it as a server route gated on
  `suRecognised`. Do not widen any client-side `users` read.
- **Roster route staleness.** `useTaskRoster` fetches once on mount. If someone
  is added to one of the viewer's tasks mid-session their name resolves only
  after a reload. Acceptable for now; revisit if it annoys.

### PR D: state-change confirmation emails

Not covered by #119 (which closed a different consent hole).

- On unsubscribe (self or admin): send a courtesy "you have been unsubscribed, one click to re-subscribe" email with a signed re-sub link.
- On admin re-subscribe: do not flip `subscribed` immediately. Send a "an admin wants to re-subscribe you, click to confirm" email; the recipient's click flips it. A real consent gate, not a courtesy.
- New templates: `SubscriptionUnsubscribedEmail`, `SubscriptionAdminResubscribeRequestEmail`.

### PR F: per-IP rate limit on /api/subscriptions

- Firestore-backed throttle, one doc per IP, `attemptCount` + `lastAttemptAt`, hourly reset.
- Cap 10 subscribe attempts per IP per hour.
- Over the cap returns the same 200 as the cooldown path, so the throttle is invisible to enumerators.

### Legacy channels-flag cleanup

- Drop `notifications.channels.{gmail, uniEmail}` from write paths.
- Drop the legacy `profile.newsletter` sub-doc and read-side fallbacks.
- Move the newsletter sender to row-level addressing. It still routes via the legacy channel flags, so a multi-email member can drift if an admin flips one row.
- Drop the set-status dual-write to `profile.notifications.categories` once the sender no longer needs it.

### Firestore hygiene sweep

- Slug-prefix doc-IDs across active collections.
- Broader cascade-delete slices: tasks, bookings, events, eventRsvps, newsletterDrafts, emailVerifications, plus Storage objects.
- Orphan-doc cleanup tooling: server route plus admin button, dry-run first.

## Small or deferred

- PR E leftover: default the admin Subscriptions filter to "Active". Verify whether still wanted after #118 and #123.
- Dev test-account convenience: a dev-only allowlist that auto-stamps `uniEmailVerifiedAt` so test signups skip the verification click. Plus-addressed uni emails (`name+t1@nottingham.ac.uk`) already give distinct identities with no code change.
- PR H: timing-side-channel hardening on /api/subscriptions. Deferred unless enumeration attempts show up in logs.
- v2: self-service recovery for a lost Google account. Backburner. Needs a full cross-collection account migration, since a new Google account is a new Firebase uid. Until then, "I lost my Google account" is committee-handled (admin deletes the stale account, user re-registers).

## Ops follow-ups

- Confirm the `accounts@naisi.uk` inbox exists or forwards. The "already registered" email from #125 points users there for recovery.
- `verify-email/send` has a TEMPORARY block bypassing the `@nottingham.ac.uk` check for a demo account. Revert before re-locking registration.
