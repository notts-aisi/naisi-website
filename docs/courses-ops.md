# Courses platform: operations runbook

Operational reference for the parts of the courses platform that live outside
the codebase: secrets, the external scheduler, and the order things have to be
deployed in.

> Status: this file starts with the scheduler tick, which is the first piece of
> courses V3 infrastructure that needs work in the Google Cloud console, and
> now also carries the draft-read narrowing, the membership cutover, the SU
> list import and the logged export.

> continues with PUSH ATTENDANCE, which is the one human action the weekly
> emails hang off, and the membership cutover, import and export. Later PRs
> extend it with the rules-and-indexes deploy order.

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

Cutover order, because two of these are switches rather than deploys:

1. deploy, with `admissions-deadline-reminders` still dark (it ships that way);
2. unpause the Cloud Scheduler job and watch heartbeat receipts for 24 hours;
3. prove the reminders job on dev with **Run now** on a round with a due date;
4. only then turn **Application deadline reminders** on from Site status, on the
   environment you mean to send from. Planned for 26 September, before the first
   reminder date on the autumn round.

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
lastError } } }`. **Missing means enabled** for the site-wide switch, and for a
job it means **that job's own default**, which is enabled for everything except
a job that mails people. A fresh project therefore runs, and a job registered by
a later PR is never silently off on an environment nobody has touched the panel
on.

The exception is declared in the registry as `enabledByDefault: false` and is
currently set on `admissions-deadline-reminders` alone. A job that emails a live
audience must not arm itself the moment it deploys, so it ships dark and the
owner switches it on from the panel. The panel says so on the job's row.

A stored row only counts as somebody having touched the switch when it actually
carries an `enabled` boolean: **Run now** writes `lastRunAt` onto a job's row
without one, and that must not arm a job that ships dark.

- Global off: ticks still arrive and still leave a receipt (so the panel does
  not go blank and read as "the scheduler has died"), but no job runs.
- Per job off: that job is skipped and says so on its receipt row.

Both switches live on the panel. Turning the global switch off also blocks
**Run now**, on the grounds that a site-wide off is usually off because
something is actively going wrong. **Run now** deliberately ignores a job's OWN
switch (the admin is looking straight at that switch when they press it), so it
is the lane for proving a dark job on dev without arming it.

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

**Not every gap is a stuck marker.** Work that was never reached leaves no
marker at all, so it cannot appear here: the unmarked-register scan considers
at most 200 live runs and at most 50 groups per run, and anything past either
cap is never chased and never recorded. Both caps are far above the shapes the
platform plans, and hitting one is logged (`candidate run cap reached` and
`group cap reached` in Cloud Logging, filtered on
`scheduler:courses-unmarked-registers`), which is the only place it shows.

Marker families and where they live:

| Family | Id | Written by |
| --- | --- | --- |
| `remind__` | `{roundId}__{uid}__{dueAtKey}` | admissions deadline reminders |
| `stagerel__` | `{roundId}__{stageId}__{uid}` | application stage release notices (one per recipient; the `{roundId}__{stageId}` form, with no uid, is the stale verdict for a whole stage) |
| `unmarked__` | `{groupId}__{sessionKey}` | unmarked-register follow-ups |
| `breakret__` | `{runId}__{groupId}__{slotStartKey}` | back-after-the-break notices |
| `wsremind__` | `{circulationId}__{uid}__{dueKey}` | worksheet due-soon reminders (not a courses job, but it shares this collection, so an operator sweeping markers meets it here) |

House rule: **scheduler-tick markers live in `schedulerMarkers`; human-triggered
course send markers stay in `courseNudges`.** The facilitator's attendance push
is a human action and keeps its `gnudge__` marker where it is.

### The registered jobs

`JOBS` in [`src/lib/scheduler/registry.ts`](../src/lib/scheduler/registry.ts) is
ordered **alphabetically by job id**. Not an aesthetic: that array is the one
line every job-adding PR touches, so alphabetical gives each new entry exactly
one correct position and the parallel merges stop arguing. Nothing depends on
the order, because the budget is checked before each job runs and a job the
tick could not reach is reported as skipped for budget on its receipt.

#### `admissions-deadline-reminders`

Emails everybody still holding an **unsubmitted draft** on an open admission
round, on the dates that round's reminder schedule works out from its deadline.

| | |
| --- | --- |
| Handler | [`src/lib/scheduler/jobs/admissionsReminders.ts`](../src/lib/scheduler/jobs/admissionsReminders.ts) |
| Marker | `remind__{roundId}__{uid}__{dueAtKey}` |
| Audience | `admissionApplications` where `roundId` matches and `status == "draft"` |
| Cap | 200 sends per tick |
| Stale after | 24 hours |
| Template | `admissions-deadline-reminder`, editable under Admin → Email designs |

**A round carries a free list of reminder slots**, up to six, each one a number
of days before the deadline and a London wall clock on that day. A new round
starts with three presets (seven days out at 10:00, three days out at 10:00,
and deadline day at 12:00) and an author edits, deletes and adds rows from the
round page's **Deadline reminders** section. An empty list means this round
sends none: the tick skips it and Send now refuses it. A list that is there but
unreadable (a hand edit, a partial restore) is read the same way, as empty
rather than as the presets, so a document in a state nobody intended goes quiet
instead of mailing everyone holding a draft three times. The list is the same
shape, and the same editor, as a worksheet circulation's due-soon slots
([`src/lib/reminders/slots.ts`](../src/lib/reminders/slots.ts)); the field on
the round document is still called `reminderOffsets`.

**A slot is labelled from its own numbers**: "3 days before the closing date at
10:00", "On the closing date at 12:00". It used to be three fixed rows with
fixed names over an editable number of days, so a row edited from seven days to
four still read "A week out". A label written from the numbers cannot be wrong
about what it sends.

**Nothing is scheduled.** Each tick reads every open round's `closesAt` and its
slots and derives the due instants again: `closesAt` minus the slot's days, in
**civil** days, then set to that slot's London wall clock. So moving a deadline
moves its reminders with it, and there is nothing to reschedule.

**The marker keys on the resolved civil date**, never on the slot id. Two
consequences, both deliberate:

- editing the schedule cannot re-send a date that has already gone out (nudging
  "10:00" to "12:00" on the morning it went is the same key, so nobody is
  mailed twice);
- two slots that resolve to the same day are **one** email, sent at the
  earlier of the two times.

A slot id is opaque: nothing reads one, and the three ids the fixed rows used
to carry (`t7`, `t3`, `dday`) are still perfectly good ids, so a round authored
before the free list existed keeps its rows, its dates and its markers.

**Stale work is dropped whole, not mailed late.** A due date more than 24 hours
old is recorded with `skippedReason: "stale"` and nobody is emailed: a "closes
in 7 days" email that lands three days after the deadline is worse than
silence. That stamp is **one marker per round and date**, with `nobody` in the
uid slot, rather than one per applicant, because the verdict is
identical for everybody on that date and is re-derived on every tick.

**A stale date is not on Stuck sends, and there is no button for it.** Stuck
sends lists markers stamped `failedAt`; a stale one is stamped
`skippedReason: "stale"` with `failedAt` null, so it never appears there.
Neither the tick nor **Send now** will send that date afterwards either: both
re-derive it from the same clock and reach the same verdict. The only signal
that a date went by unsent is the **stale** count on a Send now receipt (and
the job's log line).

If a date really has been missed and the email is still worth sending, the
remedy is a manual one-off, outside the scheduler entirely: read the wording
under Admin, Email designs (its Send test mails it to you, not to the round),
and have the committee send that note by hand to the people who need it. An
explicit admin override that puts a stale date back in play is a plausible
follow-up; it does not exist today.

**Who is skipped.** A suppressed address, an explicit courses opt-out
(`profile.notifications.categories.courses === false`; an unanswered preference
is not a refusal), or an applicant with no address on file. Each is stamped with
its reason rather than left unmarked, so the tick does not re-decide it every
fifteen minutes.

**It ships switched off.** `admissions-deadline-reminders` is registered with
`enabledByDefault: false`, so on a fresh environment it is dark and the panel
says why on its row. **The owner turns it on from Site status once the round is
open and a run has been proven on dev** (planned for 26 September, ahead of the
first reminder date). Until then the tick skips it and **Send now** refuses,
naming the switch, so the manual lane cannot bypass the dark period by accident.
**Run now** on the panel still runs it, which is how you prove it on dev without
arming it.

**Send now.** The round page's Deadline reminders section has a **Send due
reminders now** button (admins and `approveCourse` holders). It calls
`POST /api/admissions/rounds/[roundId]/reminders/send-now`, which runs the SAME
handler scoped to that round: it claims the same markers, so pressing it twice
sends nothing the second time, and it honours the same 24-hour rule, so it
cannot be used to mail a reminder late. It refuses a round that is not open, refuses
while the site-wide scheduler switch is off, and refuses while the reminders
job's own switch is off. The receipt it shows is
`sent / skipped / stale`, plus `failed` when it is not zero, and "There may be more: press again" when the run stopped at its ceiling.

Use it when a tick has slipped on one of the dates. It is also what makes this
whole lane safe to cut under time pressure: without the scheduler, deadline
reminders are a committee member pressing one button on each of the days the
round's schedule names.

#### `admissions-stage-release`

Tells everybody still live on an admission round when the **next part of its
form** opens.

| | |
| --- | --- |
| Handler | [`src/lib/scheduler/jobs/admissionsStageRelease.ts`](../src/lib/scheduler/jobs/admissionsStageRelease.ts) |
| Marker | `stagerel__{roundId}__{stageId}__{uid}`, one per recipient |
| Audience | `admissionApplications` where `roundId` matches and `status` is `draft` or `submitted` |
| Cap | 200 sends per tick |
| Stale after | 72 hours |
| Template | `admissions-stage-released`, editable under Admin, Email designs |

**It announces; it does not release.** The release is derived at read time by
`isStageReleased`, on every serialisation of every stage, so a stage whose
release instant has passed is already serving its questions whatever this job
does. A tick that never ran, a scheduler somebody switched off, a send that
bounced: none of them can hold a question back. That is the whole point of
putting the boundary in a predicate, and it is why this job is safe to leave
switched off.

**Who hears about it.** Everybody on the round holding a `draft` (still
writing) or a `submitted` application (sent an earlier stage, and now has more
to write). Withdrawn and decided rows are out.

**A stage that opens WITH the round is never announced.** `releaseAt: null`
means "this stage is the form": it becomes readable the moment the round opens,
which is when the round's own announcement and apply link are the news. Such a
stage claims no marker and sends nothing.

**One marker per RECIPIENT**, `stagerel__{roundId}__{stageId}__{uid}`, claimed
before that person's send and stamped after it. Exactly the deadline
reminder's shape, and for the same two reasons.

The first is the attempt budget. A claim is capped at three attempts, and a
round bigger than one tick's 200-send ceiling needs a re-claim per partial run.
A stage-wide marker therefore spent its whole budget on ordinary partial runs:
a round over roughly ninety live applications was given up on after three
healthy ticks, stamped `failedAt` with a "no send" error it had not had, and
the last applicants were never told. The second is write throughput. The
stage-wide shape carried a resume cursor on one document, written once per
recipient, against Firestore's ceiling of about one write per second per
document; the write was swallowed on failure, so under load the cursor quietly
stopped advancing and a re-claim re-mailed people who had already had the
email. Both are gone: there is no cursor, and each person carries their own
attempt budget.

**A single failed send IS retried**, on the next tick, for that person alone. A
failed send leaves that recipient's marker unstamped (`stampError` writes only
`lastError`), which is what the re-claim rule picks up after
`reclaimAfterMinutes`. Nobody else is touched, and nobody is mailed twice. A
recipient who is still failing after three claims is stamped `failedAt` and
appears under **Stuck sends** with a Retry button.

**Stale work is dropped whole.** A release more than 72 hours old is recorded
on ONE stage-level marker, `stagerel__{roundId}__{stageId}` with no uid, as
`skippedReason: "stale"`, and nobody is mailed. Three days rather than the
reminders job's one, because this is news rather than a countdown. That marker
is written already settled and is never claimed: it records a verdict rather
than authorising a send, so it spends no attempt on anything. Once a stage is
stamped stale, **neither the tick nor the Release now button will announce it
afterwards**: both re-derive the same verdict from the same clock. **Retry on a
stale marker will not announce the stage either**: the button puts the marker
back in play, and the next run re-derives "too late" and settles it again, so
the only thing Retry changes is the marker. The stage is still released and its
questions are still being served. If the announcement is still worth making,
send it by hand (the wording is under Admin, Email designs; its Send test mails
it to you, not to the round).

**Lateness is measured from when the stage could first be SEEN**, which is the
later of its release instant and the round's `opensAt`. A stage scheduled for a
date before the round opened was visible to nobody on that date, and measuring
from the schedule alone would have stamped it stale on the day it first
appeared.

**It ships switched off.** `enabledByDefault: false`, same reasoning as the
deadline reminders: it emails applicants, and a missing `config/scheduler` row
must not arm it on whatever data an environment happens to hold. Arm it from
Site status once a round's stages are authored and a run has been proven on
dev. **Run now** on the panel still runs it while it is dark, which is how you
prove it without arming it.

**Release now.** The round console's stage card has a **Release now** button
(admins and `approveCourse` holders). It is a POST and only ever a POST: a read
path that could publish an intake's questions is the one thing this tree cannot
have. It stamps `manualReleasedAt`, which brings a release forward and can
never push one back, and then runs THIS job scoped to that one stage, claiming
the same per-recipient markers. So a hand release and a tick a minute later
cannot both mail anybody, and a second press reports the release it already
made, moves no timestamp and sends nothing.

It refuses a round whose application window is not open (draft, archived,
not yet opened, closed, or cancelled), mirroring the predicate the job itself
gates on: releasing a stage there either does nothing or quietly publishes the
questions the moment the window opens, neither of which is what the button
says.

The button honours both switches, so while the scheduler is off site-wide or
this job is dark it releases the stage and says plainly that nobody was
emailed. The release is committed before the send is attempted, so a Resend
outage can only cost the email. The receipt names WHICH kind of nothing
happened: announced, already announced, the round not in its window, the stage
not read as newly opened, too late, the scheduler or the job switched off, no
live applications, or a send that failed. Each is its own sentence, because an
admin told "already announced" about a round whose window is shut goes looking
for an announcement nobody made.

#### `heartbeat`

Sends nothing and claims no marker. Leave it on: it is how you tell a scheduler
that is running from one that is silently down.

`src/lib/scheduler/registry.ts` is the list, and it is ordered **alphabetically
by job id**. That is a mechanical rule, not a curated order: several PRs splice
into the same array in the same fortnight, and alphabetical is an order every
branch computes the same way, so a rebase stays a rebase. Every handler carries
a wall-clock budget of its own, so no job needs to be earlier in the list to be
safe. The heartbeat is somewhere in the middle now; a tick that runs out of
budget before reaching it still writes a receipt with its row on it, marked
skipped, so "is the scheduler running" is still answered by the panel.

#### `courses-unmarked-registers`

Raises a committee task for every group whose register is still unpushed once
the grace has passed. Assigned to every admin, `committee` visibility,
`source: "course-register"`, due at the session's end plus the grace.

| | |
| --- | --- |
| Marker | `schedulerMarkers/unmarked__{groupId}__{sessionKey}` |
| Task id | `tasks/course-register__{runId}__{groupId}__{sessionKey}` |
| Window | sessions whose END is between the grace and the grace plus 24 hours |
| Runs scanned | status `applications-open`, `applications-closed` or `running` |
| `maxLateHours` | 72 |
| Config | `unmarkedRegisterGraceHours` (36), `unmarkedScanBudgetMs` (12000), `maxFollowUpTasksPerTick` (25) |

**The window is a band, not a threshold.** "Older than the grace" would
re-derive every unmarked session of the whole term on every tick; the marker
would suppress the writes and the reads would still happen. A 24-hour band over
a tick every 15 minutes gives each session about ninety-six chances to be seen,
which covers a scheduler that has been down for most of a day. The cost: a
register still unpushed a week later has one card and gets no second one, so
the board is the only record.

**It scans every live status, not `running` alone.** The pre-course holds its
six sessions while the admission round is still open, so its run sits at
`applications-open` throughout. Scanning `running` only would miss the one
cohort the job exists for: brand-new facilitators marking their first register.

**Unmarked means NOT PUSHED**, which subsumes "no register document" and "a
register with no marks". The push is the thing the card asks for, and a
half-marked register has had none of a pushed one's effects. A session switched
to **Didn't happen** is complete and is never chased.

**It is resumable.** `maxFollowUpTasksPerTick` caps writes, and writes are not
where a tick runs out of time: a quiet week writes nothing at all and still
walks every run, every group and every session in the band. So the scan carries
its own budget (`unmarkedScanBudgetMs`, floored by whatever the tick has left)
and a cursor over the run list at `config/schedulerCursors`. Out of time means
"stop, remember the last run finished end to end, report `hasMore`". A run
interrupted part-way through is rescanned from its first group next time, which
costs reads and writes nothing.

**If a card lands at a weird id.** The tasks create rule constrains neither
`source` nor the doc id on the committee lane, so a committee member can create
a task at the job's own deterministic id and any member can squat it on the
personal lane. On a collision the job reads the document back and accepts it as
its own only when the source, the cohort pointer and an admin completer all
agree; otherwise it mints at `…__alt` and logs
`follow-up id occupied by a foreign task`. If both ids are taken the marker is
left unsent, so it reaches **Stuck sends** rather than pretending a card exists.

**Closing a card by hand.** Push the register and it archives itself. If the
register genuinely cannot be pushed, archive the task from the board: nothing
re-raises it, because the marker is already stamped.

**Losing the cursor is safe.** Clearing `config/schedulerCursors` by hand means
"start from the top", which costs one repeated scan; every unit of work is
marker-guarded, so a second look writes nothing.

**A run that keeps throwing is stepped over.** One bad run never stops the pass:
the scan logs it, counts it in the row's `failures` map on
`config/schedulerCursors`, and carries on down the queue. A run that has thrown
on three consecutive passes is skipped from then on, logged as `stepping over a
run that keeps failing` on every pass it happens and counted on the receipt. The
count clears itself the moment the run scans cleanly; to force a retry after
fixing the run, delete this job's row from `config/schedulerCursors`. Nothing
else recovers it, so a receipt reporting `runs stepped over` week after week is
a thing to go and look at rather than background noise.

**Switch it off on the panel until dev has seen it work.** The job has no
per-job default-off flag of its own yet, so the first tick after a deploy runs
it for real against whatever cohorts are live. Turn it off on the site status
page **before** the deploy reaches an environment with real facilitators on it,
and only turn it back on once dev has shown all four scenarios: a session
crossing the 40-hour mark raising exactly one card; a second tick over the same
session raising none; a push archiving the card it raised; and a squatted task
id going to the `__alt` fallback rather than overwriting anything.

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

`config/schedulerCursors`, where a resumable job leaves its place, is one more
document in the existing server-only `config` collection and rides that
collection's explicit `allow read, write: if false` block. No new collection, no
rules change, and nothing in it names a person.

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

The push is also what makes the session visible to the LEARNER. Their own row
appears on their course home (the **Your progress** card) as soon as the
register is pushed, and not before: `courseAttendance` stays `read: if false`,
and the only route to a member's own mark is the overview payload's
`ownAttendance`, which drops any register with no `pushedAt`. So a register a
facilitator is halfway through saving shows nobody anything, and a session
nobody ever pushed simply does not appear on any member's list.

A cell left blank in a PUSHED register reads "Not marked" on that list, while
the summary line above it (and the reviewer's figures, and any completion bar)
counts it as an absence. That disagreement is deliberate: the count has to
treat a finished register as finished, and the row should not turn a
facilitator's slip into an accusation. If a member reports a wrong mark, an
admin corrects the register and the figures follow.

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

**The board tells you.** Once the grace has passed
(`config/courses.unmarkedRegisterGraceHours`, default 36) the
`courses-unmarked-registers` job raises a committee task naming the group, the
course and the session, assigned to every admin, saying what is waiting on the
press and what to do about it. Pushing the register archives the card.

That does not make the chase automatic, only visible. The card asks an admin to
go and talk to the facilitator, so brief facilitators on the push **before**
their first session rather than after, and watch the volume in the first
fortnight: with three streams, three fellowships and several groups each, a
quiet week can put a dozen identical cards on every admin's board, and a board
people mute is a board that stops working.

### The knobs

Both live on the site status page, under Course settings:

- **Weekly feedback form** (`config/courses.weeklyFeedbackUrl`). Rides the
  reminder as `{feedbackUrl}`. Leave it empty and the paragraph carrying it is
  dropped from the email whole, which is a complete state rather than a broken
  one.
- **Unmarked register grace period**, above.

Two more sit on `config/courses` with no editor, because they are scheduler
cost dials rather than product settings: `unmarkedScanBudgetMs` (12000, the
scan's own wall-clock bound) and `maxFollowUpTasksPerTick` (25, the cap on
cards raised in one tick). Set them from the Firestore console if a scan is
consistently reporting `hasMore`. Missing means the default, always.

`unmarkedScanBudgetMs` is a share of the 28s the tick hands its whole job list,
and it is meant to **shrink as jobs are added**. Today one real job runs, so 12s
is generous; with the admissions and break-return jobs registered alongside it,
a scan allowed to spend most of the list's budget is a scan that starves every
job after it. Rule of thumb when raising it: the sum of the jobs' own budgets
should stay under 28s.

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

Then record members: from the table on the Membership page, or from their rows
on the Members tab. The rules need no deploy (every membership collection is
`allow read, write: if false`, which is identical to Firestore's implicit
deny), but the export DOES need one index: `memberships (periodId, tier)`,
which is what the CSV's tier ordering pages on. Deploy indexes before the first
export or it fails with a link to create it.

## Importing the SU list

**Deploy the indexes before the first import.** `firestore.indexes.json`
carries a `fieldOverrides` entry putting a COLLECTION_GROUP index on
`rows.matchedUid`. Firestore builds single-field indexes automatically for a
collection but never for a collection group, so that one has to be declared and
deployed by hand:

```sh
npx firebase deploy --only firestore:indexes --project <default|dev>
```

Without it the import still runs, and so does everything on the console. The
casualty is quiet and later: deleting an account sweeps the import rows that
name that person with a collection-group query, and an undeclared index makes
that query fail rather than return nothing, so the rows outlive the account.
Deploy it on a backend before its first import, not after.

The Students' Union sends a CSV. On **Admin, Membership**, under *Import the SU
list*:

1. Pick the period the list is for, and the tier to use for rows whose file has
   no membership type column (nearly always **paid**).
2. Choose the file or paste it, then press **Read the file**. This is a DRY
   RUN. It records nothing. It reports how many rows matched on a verified
   university email, how many on a sign-in email, how many matched only on a
   name, how many repeated somebody from an earlier line, and how many have no
   account here at all. Most society members have no account, and that is
   normal rather than a fault in the file.
3. Tick each name-only match you are willing to vouch for. They will not commit
   otherwise, whatever the browser sends, and the row records who ticked it.
4. Press **Commit**. It works in chunks of two hundred people and keeps going
   until the list is done, so a six hundred row file is three calls and a
   dropped connection costs you a press rather than the import.

Things worth knowing before you run it:

- **It never overwrites.** A person who already has a membership row for that
  period is skipped with the reason on the row, so a bursary you granted by
  hand this morning survives a list that says they paid. Settle those from the
  table.
- **Running it twice does nothing twice.** Committed rows are stamped, so a
  second press is a no-op.
- **A name matching two accounts is not a match.** It is reported unmatched
  with the reason, because there is nothing for a person to confirm except a
  guess.
- **An import survives closing the tab.** The panel lists every unfinished
  import on the period when it loads, so you can pick one up where it stopped.
  **Abandon** closes one you are not going back to: it deletes no rows and
  takes back no membership already recorded, it only stops the import showing
  as unfinished.
- **An upload that says it did not finish writing its rows** cannot be
  committed. Abandon it and read the file again. It means the dry run died
  partway through, so the row count on it is a promise the rows did not keep.
- **An alumni row will not take away a badge it cannot account for.** If
  somebody's account says they were a member this year and there is no
  membership row behind that, the row is skipped with the reason rather than
  quietly stripping it. Settle those from the Members page.
- **If a commit says the totals could not be moved**, the memberships were
  still written and only the four counts above the table are behind. Press
  **Recount** on the Members card: it counts the membership rows and rewrites
  all four.
- **Deleting an account deletes its import rows** and keeps the batch, which is
  the provenance behind every membership that import recorded.

## Exporting the membership list

**Export CSV** on the Membership page. Every export is recorded: who took it,
which period, how many people were in it, and the filename. If that record
cannot be written the export is refused, so a file never leaves without a log
line behind it. Say so if anybody asks why the button failed.
