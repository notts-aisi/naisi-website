# Notifications

Every message this site sends a member goes out on one of three terms, and the
member sees one grid on `/profile` that says which of them apply to them. This
file is the reference for the whole feature (built September 2026): the three
classes, the four rows and two columns, what reads them, what sends today, and
what a new sender has to declare.

The model lives in `src/lib/firestore/notifications.ts`. That file is
authoritative for the shape and the defaults; everything below is a summary of
it plus the surfaces it feeds.

## The three classes, and the one rule that orders them

| Class | What it does | Examples |
| --- | --- | --- |
| **grid** | Consults the member's row for its category before it sends | the newsletter, the new-event announcement, cohort mail, task and worksheet mail |
| **transactional** | Never consults it, because the member asked for this message by doing the thing it is about | a magic link, an RSVP confirmation, a decision on their own application |
| **notice** | Deliberately ignores it: a person responsible for an audience is addressing that audience about something they signed up for | an organiser telling attendees the room moved, a facilitator writing to their group |

The rule: **every send belongs to exactly one class, the choice is made at the
call site, and the choice is invisible in a diff.** A route that emails a whole
cohort and a route that emails one applicant look identical; the only difference
is whether a preference was read three functions earlier. So the choice is
written down, per (file, symbol), with a reason, in
`tests/notification-classification.test.mjs`, and that guard walks the tree in
both directions. See [Adding a sender](#adding-a-sender).

**Suppression is bypassed by none of them.** `sendEmail` filters against
`suppressedEmails` before it renders and stays the one door out of the product
(`tests/email-suppression-chokepoint.test.mjs` pins that). A notice bypasses
PREFERENCES, never DELIVERABILITY: a bounce or a complaint is a fact about an
address, not a choice.

**Push cells gate push only.** A transactional email's push mirror consults its
row's push cell; the email is sent either way. The two cells of one row are two
answers, so a member who switches the email off and leaves the push on has said
"on my phone, not in my inbox", and the senders honour that literally.

## The four rows and two columns

Four rows (`newsletter`, `events`, `courses`, `tasks`), two columns (Email and
Push), every cell a boolean. Defaults are per row, not uniform, because two
different consent stories were already live when the grid landed.

| Row | Label | Email default | Push default | Why |
| --- | --- | --- | --- | --- |
| `newsletter` | Newsletter | **off**, opt-in | **off**, opt-in | Consent basis. Nobody consents to bulk mail by having an address, and this row also mints `subscriptions` records, so a default of on would be a consent claim we cannot evidence |
| `events` | Event announcements | **off**, opt-in | **off**, opt-in | The same, and also a `subscriptions` row |
| `courses` | Course announcements | **on** unless a stored `false` | **on** unless a stored `false` | The opt-in is the `cohort:<runId>` subscription row written when a member is placed in a group. The row is the refusal layered on top, so only a stored `false` counts |
| `tasks` | Tasks and worksheets | **on** unless a stored `false` | **on** unless a stored `false` | The opt-in is volunteering for the task. A default of off would silence, for everybody at once, mail members already receive |

The rule is one table, applied to both columns:
`OPT_IN_ROWS = ["newsletter", "events"]` resolve `Boolean(v)`;
`OPT_OUT_ROWS = ["courses", "tasks"]` resolve `v !== false`. `resolveRow()` is
the only place that decision is made, and a row in neither list resolves OFF, on
purpose: silence is the recoverable failure.

So **absent means different things per column of one row only by accident of the
row, never of the column**. On `newsletter` and `events`, absent means "has not
opted in" and nothing is sent. On `courses` and `tasks`, absent means "has not
answered" and mail is sent. Junk (a string, a null, a number) is not an answer
either way: it reads as the row's default.

Only the two opt-in rows mint subscription records, through
`SUBSCRIPTION_CATEGORIES` and `/api/subscriptions/sync`. `courses` and `tasks`
are addressed by uid or by cohort channel rather than by list membership, so a
per-address checkbox for either would create a top-level row nothing ever sends
to. Their membership, order, and the `CATEGORY_LABELS` strings for those two
rows are pinned: `scripts/e2e-fixtures/member-journey.mjs` regex-parses them out
of the module and refuses to seed a browser run when they drift.

## The stored shape

```
users/{uid}.profile.notifications = {
  channels:   { gmail, uniEmail },                    // address routing
  categories: { newsletter, events, courses, tasks }, // the EMAIL column
  push:       { newsletter, events, courses, tasks }, // the PUSH column
}
```

**Two parallel maps, and no `{ email, push }` container inside `categories`.**
Such an object is truthy, so every `Boolean(categories.x)` read in the tree would
report every row as wanted for every member, the two `!== false` reads would
never see a refusal again, and the leaf writers that set a category by dotted
path would silently replace it. Sibling maps keep every existing reader and
writer type-correct.

`channels` is EMAIL-ADDRESS ROUTING, which inbox a send lands in, and is not a
column. A push notification has no address, which is why push is a third map
rather than a channel: folding it in would break `addressesForSend`.

### Legacy shapes still read

`normaliseNotifications()` is the one reader, and it has three branches plus a
push resolution outside them:

1. **Modern**: a `notifications` map carrying `channels` or `categories`. Each
   cell through `resolveRow`.
2. **Legacy `newsletter`** (`{ subscribed, deliverToGmail, deliverToUniEmail }`),
   used only when no `notifications` field is written yet. `subscribed` becomes
   the newsletter row, events is false, and **courses and tasks resolve TRUE**.
   That is spelled out rather than defaulted: under the resolver a stored `false`
   is a refusal, the legacy shape has no slot for either row and so cannot
   express one, and returning false would invent a refusal nobody made.
3. **Neither**: `DEFAULT_NOTIFICATION_PREFS`.

**Push is resolved outside that either/or.** The two email shapes are competing
versions of one answer, so exactly one may win; push is an axis neither version
ever carried, so it is read once and attached to whichever branch returns. That
is what makes a legacy profile still come out with the opt-out push rows on, and
why a member who has only ever touched the push switches keeps their stored
`false`.

`push.courseDecisions` is the old name of the `courses` push cell, from when the
push map had topic-shaped keys of its own. It is READ as an alias and only when
`push.courses` is absent (a member who has answered under the new key has
answered), and it is never written again.

### Who writes it

- `/profile` writes the whole `profile.notifications` map on Save, and the push
  column writes a leaf at `profile.notifications.push` on every toggle. See
  [The profile grid](#the-profile-grid).
- `/api/unsubscribe` writes only the category keys its token actually names, as
  dotted field paths, and iterates `UNSUBSCRIBABLE_CATEGORIES`. See below.
- `/api/admin/migrate-notifications` writes `channels` plus the newsletter and
  events cells and nothing else. Backfilling a `courses` cell from the legacy
  shape would opt every legacy member out of cohort mail, because that shape
  cannot express an answer for a row it never had.
- `/api/admin/subscriptions/[id]/set-status` writes one leaf under
  `.categories.*`, for a subscription row an admin flipped.
- `completeRegistration` in `src/auth/signInWithGoogle.ts` writes the whole map
  once, from the register form, and mirrors the newsletter answer into the
  legacy `profile.newsletter` field.

`firestore.rules` needs no key whitelist here and deliberately has none: the
owner may write the whole map or any single leaf under `.categories.*` and
`.push.*` on their own document, and `notifications` stays ONE key of `profile`
so the size caps are untouched. `scripts/rules-tests/tests/users-push-preferences.test.mjs`
asserts that absence as a property.

## The two server reads

Two helpers, one per column, and they differ in exactly one place.

| | Email | Push |
| --- | --- | --- |
| Helper | `wantsEmailForProfile(profile, row)` in `src/lib/email/preferences.ts` | `wantsPushFor(uid, row)` in `src/lib/push/preferences.ts` |
| Takes | the profile the sender is already holding | a uid, and reads the document itself |
| Absent or junk cell | the row's default | the row's default |
| No user document | the sender has already skipped them: no document, no address | the row's default |
| A read that FAILS | **the row's default**, so an opt-out row still sends | **no**, always |

The missing-document answer used to be the one cell of that table that did not
resolve the row's default: it answered yes on every row, on the reasoning that
deleting an account deletes its `pushSubscriptions` rows in the same pass
(`src/lib/firestore/accountDeletion.ts`), so the branch was reachable only
through a deletion whose subscription sweep had failed. That held for a sender
addressing a uid it already knew and not for one that enumerates devices: the
event announcement reads `pushSubscriptions` and asks the row per distinct
owner, so a device row whose owner's document was gone would have been pushed an
opt-in row's notification nobody had asked for. Since 7 September 2026 the
branch resolves the row's default like an absent cell, and the column has one
rule.

The email helper takes a profile rather than a uid because every grid sender
already reads `users/{uid}` for the address and the name; a second read per
recipient to ask one boolean would double the cost of every send loop on the
platform.

**Why the failed-read rule differs.** `wantsPushFor` fails closed because a
dropped push loses nothing (the email it mirrors still goes) while a push to
somebody who switched them off is the exact thing the preference exists to
prevent. Neither half of that holds for email on an opt-out row: the email is not
a mirror of anything, so refusing it loses the message itself (a review request,
a worksheet deadline, an announcement to a cohort the member is enrolled in), and
the member has not refused it, because only a stored `false` is a refusal and a
failed read is not a stored false. Silencing mail nobody refused on the strength
of a transient Firestore error is the worse mistake and the one nobody would
notice. The opt-in rows keep failing closed for free, because their default is
off.

`hasOptedOutOfCourseAnnouncements()` in `src/lib/email/courseFacilitatorEmails.ts`
is that helper inverted, for the loops that hold a raw document and are asking
"has this person refused?".

## What sends today

| Row | Email | Push |
| --- | --- | --- |
| `newsletter` | `POST /api/newsletter/[id]/send`, the only sender that addresses this row | the same send, alongside its email loop |
| `events` | the new-event announcement, on publish | the same announcement |
| `courses` | the cohort announcement composer, the weekly session nudge, the run catch-up nudge, the admissions deadline reminder job, the admissions stage-release job | an admissions decision, an allocation publish, the stage release |
| `tasks` | the five `/api/tasks/[id]/*` senders, the four worksheet circulation messages, the worksheet due-soon reminder | a mirror beside each of those |

**The two opt-in rows share one push audience shape**, in
`sendPushToRowAudience` (`src/lib/push/rowAudience.ts`): every account with a
device whose cell for that row is on, enumerated from `pushSubscriptions`,
deduped by owner, one preference read each, refused whole over 500 device rows.
The newsletter send and the event announcement both call it, each naming its own
row, and each dispatches it CONCURRENTLY with its email leg because two bounded
loops in one request cost the larger rather than the sum.

Only `newsletter` and `events` may be addressed that way, which is why the
helper's row parameter is narrower than the four. Their cells resolve OFF when
absent, so a scan of every device reaches only the accounts that answered yes.
On `courses` and `tasks` an absent cell resolves ON, so the same scan would
notify every account that has ever enabled a device; those rows are addressed by
uid instead, by the mirrors beside their emails.

The newsletter notification carries the subject and lands on `/dashboard`. A
newsletter has no web view at all (the only render of one is
`POST /api/newsletter/preview`, gated to drafters and approvers), and this
audience is signed-in accounts with a registered device by construction, so the
signed-in home is the most useful page every one of them can actually open.

The `courses` email senders resolve their audience through `resolveCohortAudience`,
which drops anybody whose row is a stored `false` before a message is rendered.
The two admissions jobs read the row per recipient, off the user document they
fetch for the name, and carry on with the opt-out unset when that read fails.

The `tasks` senders run **their gates in series, any one a skip**, and the
member's row is always the last. The order of the gates above it is per lane,
cheapest read first: the five task routes read the site-wide
`config/taskEmails` kill switch and then the row; `src/lib/worksheets/notify.ts`
reads the circulation's own switch for this event first, because it is already
loaded and costs nothing, then the kill switch, then the row; the due-soon
reminder job reads the kill switch once per run, then the circulation's
`dueSoon` toggles, then the row per recipient. The row gates EMAIL only; the
push mirror reads the push cell for itself, which is why a member who has
switched the email cell off still gets the notification.

Every push cell is read in exactly one place: `push.tasks` in
`src/lib/push/taskNotifications.ts`, `push.courses` in
`src/lib/push/courseNotifications.ts`, and `push.newsletter` and `push.events`
in `src/lib/push/rowAudience.ts`, which reads whichever of the two its caller
names.

## The marketing unsubscribe link's reach

`UNSUBSCRIBABLE_CATEGORIES = ["newsletter", "events", "courses"]`, and
`/api/unsubscribe` iterates that, never `ALL_CATEGORIES`.

`tasks` is deliberately absent. A member clicking unsubscribe at the foot of a
newsletter is refusing bulk mail; silencing their review requests, mentions and
worksheet deadlines on the same click would take away mail they need to do the
thing they volunteered for, without ever telling them. That row is switched off
on `/profile`, where the copy says what it stops, and nowhere else.

The route also writes only the keys its token names. Rebuilding the whole
`categories` map and writing it back would collapse absent into `false` on every
row, which once `courses` joined the list meant an unsubscribe click on a
newsletter stamped a course-mail refusal the member never made.

## The notice lane

A notice reaches its audience on both channels whatever the grid says. Email goes
through `sendNotice` in `src/lib/email/notice.ts` (a wrapper over `sendEmail`,
never a second door); push goes through `sendNoticePush` in
`src/lib/push/noticeNotifications.ts`, the one push in the estate that reads no
preference at all.

### The surfaces

| Surface | Route | Who may send | Audience |
| --- | --- | --- | --- |
| `event-broadcast` | `POST /api/events/[id]/broadcast` | admins, SU-recognised committee, and the event's `authorUid` or anyone in its `collaboratorUids` while that account is still approved | the event's confirmed and waitlisted RSVP rows; the composer can untick waitlisted |
| `event-cancel` | `POST /api/events/[id]/cancel` | admins and `approveEvent` holders, matching publish and update | the same two statuses, always both |
| `course-group` | `POST /api/courses/groups/[groupId]/email` | admins, and a facilitator of THIS group while it is live | the group's active members |
| `course-room` | `POST /api/courses/groups/[groupId]/notice` | the same gate | the same members |
| `course-run` | `POST /api/courses/runs/[runId]/email` with `asNotice: true` | admins, and the run's `runFacilitatorUids` or `trackLeadUids` | the run's cohort channel, keeping the members whose `courses` row is a stored false |

The event broadcast gate is wider than it was, on purpose: until this lane landed
the committee member who organised an event could not mail its attendees unless
the SU had separately recognised them. Being named on an event is a
responsibility rather than a standing credential, so the route asks a second
question of the person holding it: a pending or rejected account fails the
approved-account test even while its name is still on the event. An organiser
demoted from committee back to member passes it, and keeps the lane for the
events they authored: they are still an approved member and still the person
responsible for that event.

The post-publish change notice `EventEditor` sends after an edit to a published
event goes through the broadcast route, over the diff `update/route.ts` returns.

### Counts, never addresses

RSVP addresses are PII that `firestore.rules` restricts to SU-recognised
committee and admins, and the broadcast gate now admits people who are neither.
So no caller supplies addresses or uids: every route derives its audience server
side and answers with counts, exactly as the course lanes already did. The
console lines carry an RSVP row id or a uid, never an address.

One `sendNotice` per address, a single string as `to`, no Cc and no Bcc. Batching
an event's attendees into one envelope would disclose every attendee's address to
every other attendee.

### The caps

`reserveNoticeSlots` in `src/lib/email/noticeCaps.ts` claims every window in ONE
transaction, so a refusal on either leaves both counters untouched, and the slot
is spent when the send is ATTEMPTED. A request that dies half way through a
forty-person dispatch has already delivered part of the mail, and its retry has
to be rationed like any other send.

| Lane | Hourly, per (sender, audience) | Daily, per audience | Recipient ceiling |
| --- | --- | --- | --- |
| event broadcast | 3 | 10 | 300, refused |
| event cancel | **none** | 10, the broadcast's own counter | 300, refused |
| course group email | 3 | 10 | 100 members, refused |
| course room notice | **none** | 10 | 100 members, refused |
| course run notice | 3 | 10 | 200 recipients, refused |

**Two lanes omit the hourly window, for the same reason.** The room notice has to
survive the evening where the room changes twice and the mode flips once, which
is what its 10-a-day per-group counter bounds instead. The cancellation shares
the broadcast's hourly key, so keeping it would mean an organiser who sent three
change notices during a chaotic afternoon is refused the one message nobody can
be left without: the most time-critical send in the lane rationed by the most
routine one. A cancellation happens once per event anyway, enforced by the
already-cancelled check rather than by a throttle.

The cancellation claims its slot BEFORE the status write, so a refused request
changes nothing at all. The alternative answer is "the event is cancelled and
nobody was told".

A ceiling is a **refusal, never a truncation**. A partial send is the worst
outcome available because it looks successful: an arbitrary 300 get the mail, the
report says 300 sent and none skipped, and the retry re-mails the same 300.

### The marker, the receipt, and what still applies

The email carries a visible marker above the body, built by `sendNotice` from the
surface and rendered by `src/emails/NoticeMarker.tsx`: an eyebrow reading "Sent
as an important notice" and one sentence saying why it reached them, that their
settings did not stop it, and that it is never marketing. A template chooses
where it sits; it never chooses what it says, which is why callers pass a render
function rather than a finished element.

There is no unsubscribe footer and no `List-Unsubscribe` header, and
`listUnsubscribe` is not in `sendNotice`'s signature. Offering to switch off
something that cannot be switched off is the one dishonest thing this lane could
ship.

The `emailSends` receipt carries `kind: "notice"` plus `surface`, one of the five
strings above, so the deliverability tab can answer "how much un-switch-off-able
mail went out, and from where" without reading subject lines. Both are set by
`sendNotice` alone. The older `course-notice` kind stays defined for the room
notice's historical rows rather than being renamed: a year of them answers "how
much un-opt-out-able mail did this group send", and rewriting them would break
that question. New room notices carry `kind: "notice"` with
`surface: "course-room"` like every other lane.

Still gating a notice: suppression, a device actually being subscribed (a member
with no device gets the email alone), VAPID configuration, and a uid (a guest who
RSVP'd with an address and no account gets email only). A test send is never a
notice: it reaches its own sender, so nobody's preference is bypassed and the
marker's sentence would be false about it.

## The "new event published" announcement

`POST /api/events/[id]/publish` is the one moment the `events` row sends
anything. `src/lib/email/eventAnnouncement.ts` owns both audiences and runs them
concurrently.

- **Email** goes to the `subscriptions` junction, every confirmed-and-subscribed
  row on channel `events`, hydrated per member through `addressesForSend`, which
  applies the events cell and the per-address routing in one answer. The junction
  row IS the opt-in.
- **Push** goes to every account with a device whose `push.events` cell is on,
  through the shared `sendPushToRowAudience` the newsletter send also uses
  (`src/lib/push/rowAudience.ts`): enumerated from `pushSubscriptions`, deduped
  by owner. A different question, asked separately: a member can hold the email
  row and refuse the notification.
- An event with `visibility: "members"` drops GUEST rows (an address with no
  account) and counts them. The push audience is accounts by construction.

**Once per event, under a claim.** `announcedAt` is stamped on the event document
inside the transaction that publishes it, so two racing publishes cannot both
come out holding the announcement, and a later republish is not news twice. The
claim is made before the send: an announcement that fails after the stamp is not
retried, which is the better failure, because the other way round mails the whole
list twice.

**A pure refusal hands the claim back.** If the announcement refuses
deterministically before dispatching anything and nothing was sent, failed or
pushed, `announcedAt` is cleared and the response says so, because otherwise the
claim is spent and no supported action gets the announcement out. A throw is not
released: the dispatcher can reject after other workers have delivered.

**The known limit: it runs inside the publish request**, against App Hosting's
60s timeout, so it carries three ceilings. 500 junction rows read, 200 messages
sent (counted on addresses, because a member with two verified addresses is two
sends) and 500 device rows. A list that outgrows them needs the send taken off
the request path, which is a scheduler job and a different feature; raising the
numbers means redoing the wall-clock arithmetic in `src/lib/email/dispatch.ts`.
Publishing itself never fails because the announcement did.

## The profile grid

One grid on `/profile` (`src/features/profile/ProfileForm.tsx`, with the pure
rules in `src/features/profile/notificationGrid.ts`), five rows and two columns.
The four category rows come from `ALL_CATEGORIES` rather than being restated, so
a fifth row cannot appear in the model and be missing from the page.

- **Column masters.** Each column header carries a switch that sets every cell in
  that column at once. A master is a convenience over the cells, never a third
  stored value: it writes the same per-row booleans, and it reads as on only when
  every cell under it is on. Not "some", and not a tri-state: "on when any is on"
  would let a member switch the master off, back on, and find rows enabled they
  never chose.
- **The two subscription rows expand per address** when the member has two
  verified addresses, one cell per (address, row), each labelled
  "`<row>` to `<address>`". `courses` and `tasks` are plain switches.
- **The push column is disabled whenever this browser's push state is not "on"**,
  with a hint per state (`unsupported`, `needs-install`, `denied`, `off`, and the
  probe not yet finished), each ending with the load-bearing half: a setting here
  still applies to your other devices. The switches still SHOW the stored value in
  every state, because the answer belongs to the account and the member may well
  be setting it for the phone in their pocket. Only the writing is disabled.
- **The "Important notices" row is locked**: both cells drawn on, disabled,
  writing nothing, with copy saying an organiser of an event you signed up for,
  or the facilitator of your group, can send you a message about a change and it
  reaches you whichever switches you set. A member who has switched everything
  else off should learn that while they are making the choice, not the first time
  somebody sends one.
- **Two write paths on one page.** The email cells are saved by the form's Save
  button, which writes the WHOLE `profile.notifications` map (then the
  un-awaited `POST /api/subscriptions/sync`); the push cells save themselves on
  toggle through a LEAF write at `profile.notifications.push`. Flipping a
  notification must not write somebody's half-typed preferred name.
- **The dirty flag** is what makes those two coexist. A push leaf write changes
  `users/{uid}`, the form's own snapshot listener fires with it, and refilling
  every field on each snapshot would throw away an unsaved edit. A one-shot
  hydrated latch would fix that and break something else: the form would never
  see a later write from `/api/unsubscribe`, a second tab or an admin route, and
  would revert it on the next Save. So the refill is skipped only while an edit
  is in flight, and every control the Save button owns calls `markDirty`.
- **A narrow grid moves the push note.** The three columns fit everywhere the
  wide layout is drawn, but between a 961px and a 1169px window with the
  sidebar open the Push track is 133 to 186px, and a 12px sentence of 170
  characters wraps there into two or three words a line, with the row growing
  to 240px to hold it. So when the GRID is under 48rem wide (the grid, not the
  window: the sidebar collapses per user, and a media query would move the
  note in the wide case for nothing) the note leaves the Push cell, which
  keeps only its switch, and is drawn under the row description with a "Push"
  eyebrow. One sentence is on screen at a time: the same container query hides
  the copy in the cell, and the stacked layout below 60rem puts it back there.

The per-device Enable control stays on the push card below
(`src/features/pwa/PushSettings.tsx`), which now holds nothing but this
hardware's controls. The card and the column read one state machine
(`src/features/pwa/pushDevice.tsx`) so they cannot disagree.

## Adding a sender

1. **Register it** in `tests/notification-classification.test.mjs` with a class,
   a row if it is grid, a written reason, and `calls` (how many times that file
   calls that symbol). The guard fails on an unregistered call site, on an entry
   whose file or symbol has gone, and on a call count that has moved, so a second
   send dropped into an already-registered file is the same conversation as a new
   one. If the wrapper you call is not in `TRACKED`, add it there: section 7
   checks that list against the tree in both directions.
2. **A grid entry's file must reference a marker**: `wantsCategory(`,
   `addressesForSend(`, `wantsEmailForProfile(`, `wantsPushFor(` or
   `hasOptedOutOfCourseAnnouncements(`. If the row is consulted somewhere else,
   name that file in `via` and the assertion runs against it, so the delegation is
   written down rather than assumed. Each marker's own file is itself checked for
   reaching the one table of defaults, so a sixth way of asking a row cannot
   appear that resolves it by hand.
3. **A notice entry's file must reach a door** (`sendNotice(` or
   `sendNoticePush(`), and a file whose entries are ALL notice must reference no
   grid marker at all. It is a per-file rule because two files genuinely carry
   both lanes.
4. **A file whose entries are all transactional must reference neither.**

## Deliberately not built

- **A members-only announcement to members who are not on the events list.** The
  announcement's audience is the `subscriptions` junction, so a member who never
  opted in hears nothing, including about a members-only event. Reaching them
  would mean a second audience with a second consent story.
- **A re-announce path.** `announcedAt` is cleared only on a pure refusal.
  There is no "announce this again" button, because every version of one is a way
  to mail the whole list twice by accident.
