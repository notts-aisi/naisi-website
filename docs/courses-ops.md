# Courses platform: operations runbook

Operational reference for the parts of the courses platform that live outside
the codebase: secrets, the external scheduler, and the order things have to be
deployed in.

> Status: this file starts with the scheduler tick, which is the first piece of
> courses V3 infrastructure that needs work in the Google Cloud console, and
> now also carries the draft-read narrowing. Later PRs extend it with the
> membership import and the cutover checklist.

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

`courses` and `courseRuns` used to be `allow read: if isSignedIn()`. A course
with `status: 'draft'` and a run with `status: 'draft'` are now readable only
by staff:

| Collection | Who may read a DRAFT |
| --- | --- |
| `courses` | admins, `draftCourse` or `approveCourse` holders, the `authorUid`, anyone in the course's `collaboratorUids` |
| `courseRuns` | admins, `draftCourse` or `approveCourse` holders, the run's `authorUid` |

Every other status stays readable by any signed-in account. For `courseRuns`
the predicate is `status != 'draft'`, not "published or archived": there is no
`published` member of `CourseRunStatus` (it is `draft`, `applications-open`,
`applications-closed`, `running`, `completed`, `cancelled`), and `archived` is
a separate boolean orthogonal to status. A pending applicant reading an
`applications-open` run is unaffected, which is what the funnel needs.

### Two consequences worth knowing before you debug something

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
constrain on status, for example
`where("status", "==", "published")`, which narrows the candidate set to
documents the rule already allows. `RoundEditor` is the one caller that can
run as a permissionless account (an appointed admissions reviewer who is SU
committee and holds no course key): its unfiltered `courseRuns` read now fails
for that person, it already catches its own rejection, and the run pickers it
feeds render only for `canAuthor`, so nothing they were shown disappears.

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
deploy, the symptom is a `permission-denied` on a `courses` or `courseRuns`
read, and the first question is whether the caller holds `draftCourse` or
`approveCourse`, followed by whether the failing read is an unfiltered list.
