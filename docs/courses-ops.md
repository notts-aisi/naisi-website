# Courses platform: operations runbook

Operational reference for the parts of the courses platform that live outside
the codebase: secrets, the external scheduler, and the order things have to be
deployed in.

> Status: this file starts with the scheduler tick, which is the first piece of
> courses V3 infrastructure that needs work in the Google Cloud console, and
> now also carries the draft-read narrowing. Later PRs extend it with the
> membership import and the cutover checklist.

> continues with PUSH ATTENDANCE, which is the one human action the weekly
> emails hang off. Later PRs extend it with the rules-and-indexes deploy order,
> the membership import and the cutover checklist.

---

## The scheduler tick

### What it is

One endpoint, `POST /api/scheduler/tick`, called by an external scheduler every
15 minutes. It runs the registered jobs in
[`src/lib/scheduler/registry.ts`](../src/lib/scheduler/registry.ts) in order,
inside a single time budget.

Nothing about it is a queue. Every job works out what is due from live data at
tick time, so a tick that never fires costs latency and never work: the next one
rediscovers the same due work. What stops a rediscovered send going out twice is
a **marker** in `schedulerMarkers`, written before the send and stamped after it
(see [`src/lib/firestore/schedulerMarkers.ts`](../src/lib/firestore/schedulerMarkers.ts)).

There is no cron inside App Hosting. Cloud Run scales to zero and holds no
timers, so the schedule has to come from outside the container.

### Required environment

| Variable | Availability | Where it comes from |
| --- | --- | --- |
| `SCHEDULER_SECRET` | `RUNTIME` only | Secret Manager, per project |
| `NEXT_PUBLIC_APP_URL` | `BUILD, RUNTIME` | already in `apphosting.yaml` |

The `apphosting.yaml` entry must read exactly:

```yaml
  - variable: SCHEDULER_SECRET
    secret: SCHEDULER_SECRET
    availability: [RUNTIME]
```

`RUNTIME` and no `NEXT_PUBLIC_` prefix, both load-bearing. Only `NEXT_PUBLIC_`
variables are inlined into the client bundle at build time, and a bearer token
that reaches a browser is not a bearer token. `availability` controls the
**server**: `BUILD` means present during `next build`, `RUNTIME` means present
in the running container. A `RUNTIME`-only variable is not reachable by anyone
loading the site.

Note that the `availability` restriction exists only in `apphosting.yaml`. A
variable added through the Firebase console UI is always `[BUILD, RUNTIME]`, so
**do not add `SCHEDULER_SECRET` in the console**, which would build it into
something it has no business being in. It belongs in the yaml, as a secret
reference.

`NEXT_PUBLIC_APP_URL` is needed because the tick re-arms itself by calling its
own public URL. The host header is not usable: on App Hosting a server component
sees the internal Cloud Run revision URL, not the public domain.

### One-time setup, per project

Do this for dev (`naisi-website-dev`, backend `naisi-website`) and for prod
(`naisi-website`, backend `naisi`). The backend ids differ; that is not a typo.

```sh
# 1. Mint a secret. Any long random string; 32 bytes of base64 is plenty.
openssl rand -base64 32

# 2. Store it. The CLI prompts for the value.
firebase apphosting:secrets:set SCHEDULER_SECRET --project <default|dev>

# 3. Let the backend read it.
firebase apphosting:secrets:grantaccess SCHEDULER_SECRET \
  --backend <naisi|naisi-website> --project <default|dev>
```

Then create the Cloud Scheduler job in the same GCP project:

```sh
gcloud scheduler jobs create http naisi-scheduler-tick \
  --project=<PROJECT_ID> \
  --location=europe-west1 \
  --schedule="*/15 * * * *" \
  --time-zone="Etc/UTC" \
  --uri="https://<public-domain>/api/scheduler/tick" \
  --http-method=POST \
  --headers="X-Scheduler-Key=<the secret>,Content-Type=application/json" \
  --message-body='{"depth":0}' \
  --attempt-deadline=60s
```

`Etc/UTC` on purpose: the receipt bucket is floored in UTC, so a London-local
schedule would produce two identical buckets on the October clock change and
skip an hour in March.

Create the prod job **paused** and unpause it as the last step of cutover.

### Verifying it

Everything below is answerable from **/admin/site-status**, which is the point
of the panel. If you find yourself in Cloud Logging to answer one of these, the
panel has a gap worth filling.

1. Is the scheduler running? Recent ticks shows a row every 15 minutes.
2. Is a job on? The Jobs list has a switch each, plus one global switch.
3. Did anything throw? A job that threw shows its error inline.
4. Is a send stuck? Stuck sends lists markers that gave up, each with a Retry.

**Before any job that mails a human is registered, watch heartbeat receipts
accumulate on dev for 24 hours.** The heartbeat job exists for exactly this: it
sends nothing and proves the whole path (secret, receipt, config, budget, panel)
end to end.

A quick manual check with the secret to hand:

```sh
curl -i -X POST https://dev.naisi.uk/api/scheduler/tick \
  -H "X-Scheduler-Key: <the secret>" \
  -H "content-type: application/json" \
  -d '{"depth":0}'
```

A wrong or missing key answers **404**, not 401. That is deliberate: a 401
confirms both that the path exists and that the guard is a key check. If you get
a 404 with a key you believe is right, check the secret is granted to that
backend and that the rollout since granting it has finished.

#### What a failed tick looks like, and what recovers it

Not the scheduler's own retry. Cloud Scheduler retries a non-2xx, but the retry
arrives inside the same 15-minute bucket, resolves to the same receipt id, hits
ALREADY_EXISTS and returns `{"deduped": true}` having done nothing. That is the
dedupe working as designed: it cannot tell a retry of a failed delivery from a
duplicate of a successful one, and of the two mistakes, doing the work twice is
the worse one.

**What recovers a failed tick is the next delivery, 15 minutes later.** No job
loses work when one tick dies, because no job has a queue: each derives what is
due from live data at tick time, and the markers stop anything already done
being done again.

On the panel, a tick that died mid-list is a **Recent ticks row with no finish
time** (`finishedAt` is null, so the duration column has nothing to show). The
receipt is opened before the first job runs precisely so that this row exists at
all. One of them is a container that went away; a run of them in consecutive
buckets is a job wedging the tick every time, and the job list on that row names
the last job that reported.

### Kill switches

`config/scheduler` holds `{ enabled, jobs: { <jobId>: { enabled, lastRunAt,
lastError } } }`. **Missing means enabled** at both levels, so a fresh project
runs and a job registered by a later PR is never silently off on an environment
nobody has touched the panel on.

- Global off: ticks still arrive and still leave a receipt (so the panel does
  not go blank and read as "the scheduler has died"), but no job runs.
- Per job off: that job is skipped and says so on its receipt row.

Both switches live on the panel. Turning the global switch off also blocks
**Run now**, on the grounds that a site-wide off is usually off because
something is actively going wrong.

### Markers, and what to do about a stuck one

A job claims a marker with `.create()` **before** the send and stamps `sentAt`
**after** it. Claim first is the right order: the reverse turns any crash into a
duplicate send, and duplicates are the failure people complain about publicly.
The cost of this order is that a crash between claim and stamp leaves work
undone, which is why there is a recovery rule:

- an unsent marker whose claim is older than the job's `reclaimAfterMinutes` is
  re-claimed by a later tick;
- after three claims with no stamp it is stamped `failedAt` and appears under
  **Stuck sends**;
- **Retry** clears it, and the next tick works the send out from scratch.

Work that is simply too late (the tick was down for days) is stamped
`skippedReason: "stale"` rather than sent, per the job's `maxLateHours`. A
"closes in 7 days" email that lands nine days after the deadline is worse than
no email.

Marker families and where they live:

| Family | Id | Written by |
| --- | --- | --- |
| `remind__` | `{roundId}__{uid}__{dueAtKey}` | admissions deadline reminders |
| `stagerel__` | `{roundId}__{stageId}` | application stage release notices |
| `unmarked__` | `{groupId}__{sessionKey}` | unmarked-register follow-ups |
| `breakret__` | `{runId}__{groupId}__{slotStartKey}` | back-after-the-break notices |

House rule: **scheduler-tick markers live in `schedulerMarkers`; human-triggered
course send markers stay in `courseNudges`.** The facilitator's attendance push
is a human action and keeps its `gnudge__` marker where it is.

### Budget, re-arm, and the Cloud Run caveat

The backend's request timeout is 60s (`apphosting.yaml`,
`runConfig.timeoutSeconds`). The tick declares `maxDuration = 45` and gives the
job list 28s of that, leaving room to write its receipt and hand off.

When a job reports `hasMore`, the tick calls itself again with `depth + 1`, up
to depth 3. The re-arm gets its own receipt because the receipt id carries the
depth: without it the re-arm would floor to the same 15-minute bucket, hit
ALREADY_EXISTS and return having done nothing, so a backlog would wait a full 15
minutes for the next external call.

The re-arm is **awaited with a short handoff window**, not fired and forgotten.
Outside a request, a Cloud Run container's CPU is throttled to near zero, so a
detached `fetch` after the response has been sent may never open its socket, and
the re-arm silently never happens. Awaiting keeps the parent's CPU allocated
until the child request has at least been accepted.

The trade-off, stated plainly: the child does not answer until it has finished
its own work, so the parent cannot wait for it (that would chain four full ticks
into one request and bust the platform timeout). It waits 8 seconds and aborts,
which Cloud Run may propagate to the child as a client disconnection. If it
does, the backlog waits for the next 15-minute call. That is safe by
construction (every job derives its due state at tick time and every send is
marker-guarded), so a dropped re-arm costs latency, never correctness. The
receipt records what happened either way, under **More** on the Recent ticks
table.

**Ticks overlap, and that is expected.** The parent stops answering when the
handoff window closes but the child keeps working, so a re-arm chain that starts
near the end of a bucket is still running when the external scheduler delivers
the next tick. Nothing prevents that and nothing should: the alternative is a
lock, and a lock that outlives a crashed container is how a scheduler goes quiet
for a day.

The rule that follows, for anyone writing a job handler: **every handler must be
safe to run concurrently with itself.** Claim a marker before the side effect,
one marker per unit of work, and let the `.create()` decide who owns it. A
handler that instead reads a list, does the work and writes a "done" flag at the
end will double-send the first time two ticks meet.

### If the scheduler is down on a day something is due

Every job ships with a manual path, and that is deliberate: this whole lane is
survivable to cut under time pressure.

- **Run now** on the panel runs one job immediately.
- Deadline reminders additionally have a Send now on the round page, so a
  slipped tick is a click on three named dates rather than a missed deadline.

A GitHub Actions cron hitting the same endpoint exists as a fallback. Leave it
**disarmed** until an outage actually happens: it is a fallback, not a peer, and
GitHub's cron drifts under load, which would produce ticks in unpredictable
buckets.

### Rules and indexes

`schedulerMarkers` and `schedulerRuns` are both `allow read, write: if false`,
shut to every client, admins included, because a client able to write a marker
could permanently and silently suppress a send, and a client able to write a
receipt could make the next real tick believe it had already run. With
`if false` on both, the blocks are identical to Firestore's implicit deny, so no
rules deploy is strictly owed for them; they are written out so the lockdown is
stated rather than assumed.

One composite index is owed before the panel's per-job marker drill-down works:

```
schedulerMarkers: job ASC, claimedAt ASC
```

Deploy with the rest:

```sh
npx firebase deploy --only firestore:rules,firestore:indexes --project <default|dev>
```

Composite indexes take a few minutes to build and the query fails until they
are `READY`.

### Retention (a one-time owner step, per project)

Both collections grow forever on their own. A tick every 15 minutes is about
35,000 receipts a year, and a marker is written for every unit of timed work the
platform ever does.

The code already writes the field the cleanup keys on:

| Collection | Field | Written when | Horizon |
| --- | --- | --- | --- |
| `schedulerRuns` | `expiresAt` | the receipt opens | 90 days |
| `schedulerMarkers` | `expiresAt` | the marker settles (`sentAt` or `skippedReason`) | 180 days |

A marker still in flight, and one stamped `failedAt` waiting on **Stuck sends**,
deliberately get no `expiresAt`: neither may vanish from under the person it is
waiting for. Retry clears the field along with the skip that set it.

Markers get twice the receipt horizon because they answer a question that
arrives late: "did this person actually get their email", asked in February
about a January send.

**The field does nothing until a TTL policy exists**, and creating one is an
owner-level step (`datastore.owner`, or Firestore Database Admin) that is not
part of a deploy. Do it once per project, on both:

```sh
gcloud firestore fields ttls update expiresAt \
  --collection-group=schedulerRuns --enable-ttl --project=<PROJECT_ID>

gcloud firestore fields ttls update expiresAt \
  --collection-group=schedulerMarkers --enable-ttl --project=<PROJECT_ID>
```

The same two switches live in the Firebase console under Firestore, TTL. Either
way it is a console-side setting: nothing in this repo turns it on, and nothing
in this repo will tell you it is off. Check it with:

```sh
gcloud firestore fields ttls list --project=<PROJECT_ID>
```

Deletion begins within 24 hours of a document's `expiresAt` and is a background
sweep, not an instant. Rows already written before this shipped carry no
`expiresAt` and are never collected; delete them by hand if they matter, or
leave them, since they stop accumulating the moment the policy is on.

---

## Draft course and run reads (V3 W3 PR20)

### What changed

`courses`, `courseRuns` and `coursePages` used to be
`allow read: if isSignedIn()`. A course with `status: 'draft'` and a run with
`status: 'draft'` are now readable only by staff, and the authored programme
page follows the course it belongs to:

| Collection | Who may read a DRAFT |
| --- | --- |
| `courses` | admins, `draftCourse` or `approveCourse` holders, the `authorUid`, anyone in the course's `collaboratorUids` |
| `courseRuns` | admins, `draftCourse` or `approveCourse` holders, the run's `authorUid` |
| `coursePages` | admins, `draftCourse` or `approveCourse` holders, at EVERY status |

Every other status stays readable by any signed-in account for the first two.
For `courseRuns` the predicate is `status != 'draft'`, not "published or
archived": there is no `published` member of `CourseRunStatus` (it is `draft`,
`applications-open`, `applications-closed`, `running`, `completed`,
`cancelled`), and `archived` is a separate boolean orthogonal to status. A
pending applicant reading an `applications-open` run is unaffected, which is
what the funnel needs.

`coursePages` is the flat staff predicate rather than a status test because
the page document carries no status of its own: the status lives on the parent
course, and resolving it would need a `get()` billed once per candidate
document on a list, which is the pattern the rest of `firestore.rules`
refuses. Nothing loses a surface. The only client-direct reader is
`useCoursePage`, mounted by `CoursePageEditor` at
`/admin/courses/[courseId]/page`, whose gate is `requireCourseAuthorPage()`
(admin, `draftCourse` or `approveCourse`), exactly the predicate. The
logged-out marketing page is served by `fetchCoursePage.ts` on a server
component through the Admin SDK, which bypasses rules.

### Three consequences worth knowing before you debug something

**1. A course collaborator without a course permission cannot read a draft
run.** `collaboratorUids` lives on the COURSE document; a run carries only
`authorUid`. Honouring collaborators on the run would need a `get()` on the
parent course from inside a read rule, which is billed once per candidate
document on a list and is the pattern the rest of `firestore.rules` refuses.
Nothing loses a surface today: every client-side reader of a run document
(`RunEditor`, `WeekEditor`, `AdminCourseList`) sits under `/admin/courses`,
whose gate is admin OR `draftCourse` OR `approveCourse`, so a permissionless
collaborator cannot reach any of them anyway. If that changes, denormalise the
roster onto the run as a server-pinned array rather than adding the `get()`.

**2. An unfiltered client list over `courses` or `courseRuns` now fails for a
caller with no course permission.** Firestore judges a list on the query's
potential result set, not on the rows that come back, so an unfiltered query
is refused even when every stored document happens to be published. This is
fine today because no such list is issued: `useCourses()` and
`AdminCourseList` both run inside `/admin/courses`, and every public and
learner surface reads through the Admin SDK fetchers in
`src/features/courses`, which bypass rules. A future member-facing list must
constrain on status, and the constraint DIFFERS by collection because the two
rules do: `where("status", "==", "published")` for `courses`, and
`where("status", "!=", "draft")` for `courseRuns`, which has no `published`
member to ask for. Either narrows the candidate set to documents the rule
already allows. `RoundEditor` is the one caller that can
run as a permissionless account (an appointed admissions reviewer who is SU
committee and holds no course key): its unfiltered `courseRuns` read now fails
for that person, it already catches its own rejection, and the run pickers it
feeds render only for `canAuthor`, so nothing they were shown disappears.

**3. A read of a course or run document that does not exist now returns
`permission-denied` to a non-staff caller, not `exists === false`.** Both
rules dereference `resource.data` to test the status, and on a missing
document `resource` is null, so the clause cannot pass and Firestore refuses
rather than returning an empty snapshot. A staff caller is unaffected, because
the permission clauses that follow are resource-independent and one of them
still matches. So a client that distinguishes "no such course" from "not
allowed" by catching the error has to stop: for a plain member the two are now
the same response, and the honest message is "we couldn't load that course".

### What was deliberately NOT narrowed

`courseRuns/{runId}/weeks` keeps `allow read: if isSignedIn()`. Draft
curriculum is still readable by any signed-in account, and this PR does not
pretend otherwise. The week documents are read client-direct by `useWeek`,
`ProgressBody` and `useGroupWeeks`, the last of which issues an unfiltered
`getDocs` over the subcollection that a status-derived rule would reject
wholesale, and a week document carries no status of its own to test.
Narrowing that half means re-routing three learner surfaces through a server
fetcher: a feature PR, not a rules edit.

### Deploying it

This is a TIGHTENING, so the usual ordering worry (deploy rules before the
code that needs them) is reversed: nothing in the app needs this rule to
function, and deploying it early only closes reads that were open. Ship it
with the rest of the wave:

```sh
npx firebase deploy --only firestore:rules --project <default|dev>
```

No index is owed.

**Rollback** is a rules-only deploy of the previous file; there is no data
migration and no code depends on the narrowing. If a surface breaks after the
deploy, the symptom is a `permission-denied` on a `courses`, `courseRuns` or
`coursePages` read, and the first question is whether the caller holds
`draftCourse` or `approveCourse`, followed by whether the failing read is an
unfiltered list, and then whether the document exists at all (consequence 3).

## PUSH ATTENDANCE, and the two sends around it

### What the push does, in the order it does it

A facilitator marks their register during the session, saving as often as they
like. Nothing has left the building at that point: the register is a draft and
nobody outside the room can see it. Pressing **Push attendance** does three
things, and the order is the design:

1. **One transaction** stamps `pushedAt` and `pushedByUid` on the register, and
   recomputes every member's `courseEnrolments.attendance` rollup IN FULL from
   that group's pushed registers. Never a delta: a mirror that can be rebuilt
   from its source cannot drift from it.
2. **The send marker is claimed by a standalone `.create()` OUTSIDE that
   transaction**, at `courseNudges/gnudge__{runId}__{groupId}__{nextSlotStartKey}`
   (plus a `-{occurrence}` suffix from a week's second session onwards, so a
   group meeting twice inside one slot gets two reminders rather than one).
   A create collision inside a transaction aborts the whole transaction, so
   claiming it there would unlock a register because an email had already gone.
3. **The group is emailed** about its next session, one message each, carrying
   the next week's material and the weekly feedback link.

The consequence worth knowing on the night: **a send failure leaves the
register locked and the figures correct**. A second press is an idempotent 200
that sends nothing, and the mail is recovered by an admin (below) rather than by
pushing again.

### After the push

The register is admin-only. An admin corrects it from the same grid: marks, the
**Didn't happen** switch and the session note all stay available to them on a
pushed column, and every change appends its own `courseAudit` row with the
before and the after. Participant notes stay open to the facilitator,
deliberately: they are usually written after the session rather than during it.

### Recovering a push whose email failed

The register locks and the figures move BEFORE the first message goes out, so a
transport failure leaves a locked register and an unmailed group. The marker is
already claimed, so pressing **Push** again reports "already pushed" and sends
nothing. That is the correct default, and it is why there is a second lane.

**Resend reminder** sits on a pushed column for admins only. It re-sends this
group's reminder and **nobody else's**, and it records the re-send on the
group's marker exactly as the run-level catch-up records its own forces
(`forceCount`, `lastForcedAt`, `lastForcedByUid`, and an entry in `forces`
naming the marker it went over). Use it when a facilitator reports "I pushed and
nobody got the email".

Reach for the run-wide catch-up only when the whole cohort is owed the send. It
mails **every** group of the run, so using it to fix one group mails every other
group twice.

What can and cannot fail after the claim, so the failure a report describes can
be placed: the config read and the email template are resolved BEFORE the marker
is claimed, so the only thing left that can fail after it is the transport
itself.

### The two sends, and which is which

| Send | Who presses it | When |
| --- | --- | --- |
| The weekly reminder | the group's facilitator, by pushing the register | after every session |
| The run-wide catch-up | an admin, from the run's nudge page | the session-1 welcome, and recovery |

**The session-1 welcome has to be sent by hand.** No push exists before a run's
first session, so nothing in the group lane can produce it. Send it from the
run's nudge page before the first week. This is not a gap waiting to be closed
with a "first session" branch on the push: that would need its own idempotency
marker for a send that happens once per run, and the catch-up lane already has
one.

**The catch-up reads the group markers before it sends.** If any group has
already had this week's reminder from its own push, the run-wide send is
refused unless an admin forces it, and a force records the group markers it
overrode on its own marker. A cohort mailed twice in one week is on the record
either way.

**Residual risk: a mid-term `startDate` edit.** The run's own marker family is
checked across a span of six days either side of the slot, so nudging the same
calendar week twice is caught even after the dates move. The group markers are
checked at the CURRENT slot key only. So if a run's `startDate` is edited part
way through the term, the group markers a push wrote sit under neighbouring
keys, the catch-up finds none, and it can mail those groups a second time with
no force recorded anywhere. Remedy: after editing a live run's `startDate`,
treat the run-wide catch-up as unavailable for that week. If a group is owed a
reminder, use **Resend reminder** on that group's pushed column, which is keyed
on the group's own next session and is recorded on the group's own marker.

### If a facilitator never presses it

Their group loses its reminder as well as its register, and every member of
that group carries a session in a denominator reviewers will read as a
shortfall.

**Nothing tells you yet.** The unmarked-register follow-up task, which lands on
every admin's board once the grace period has passed
(`config/courses.unmarkedRegisterGraceHours`, default 36), arrives with PR25.
The setting exists and the scan's tunables are already on the site status page,
but no job reads them today: **until PR25 lands, an unpushed register is
invisible**, and the only way to notice one is to open the group's register.
Check the boards yourself in the days after a session, and brief facilitators on
the push **before** their first session, not after.

### The knobs

Both live on the site status page, under Course settings:

- **Weekly feedback form** (`config/courses.weeklyFeedbackUrl`). Rides the
  reminder as `{feedbackUrl}`. Leave it empty and the paragraph carrying it is
  dropped from the email whole, which is a complete state rather than a broken
  one.
- **Unmarked register grace period**, above.

### A cancelled session

Use the **Didn't happen** switch on the column, then push as normal. A session
marked not held leaves every denominator rather than counting as a room full of
absences, and the group still gets its reminder about the next one.

## Cutover: membership periods

Membership is a period-per-year object (`membershipPeriods/{periodId}`), and
one of them has to be marked CURRENT before any badge on the site can say
anything. Without that step every membership badge reads "not recorded", which
is indistinguishable from a broken deploy.

So, on each environment, as part of cutover and before anyone looks at a
profile:

1. Open **Admin, Membership** and create the period for the year. The year goes
   in as `2026/27`; the document id is derived (`2026-27`) and the `year` field
   keeps the slash, which is the same string `users.paidMembershipYears` has
   always stored.
2. Set the dates from the SU's membership year, and use the note for anything
   the next admin should know about that year.
3. Press **Make current**. That button is admin-only, and the route refuses
   anyone else: moving the pointer re-badges every member at once.

Then record members from their rows on the Members tab. Nothing needs a rules
or index deploy: both collections are `allow read, write: if false`, which is
identical to Firestore's implicit deny, and the `/me` query is a single-field
equality served by the automatic index.
