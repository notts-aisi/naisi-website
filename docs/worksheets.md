# Worksheets

A worksheet is a document of questions built in a rich text editor, sent to
people, answered individually, and reviewed. This file is the contract the
feature was built against (September 2026) and the reference for anyone
extending it. Where the owner's brief was silent the choice made is marked
**Decision** so it can be reversed knowingly.

## Vocabulary

- **Worksheet**: the library document. Lives in `worksheets/{worksheetId}`,
  edited by its author, never changed by anything that has been sent.
- **Circulation**: one act of sending a worksheet to people. The name was the
  owner's to pick and was not; **Decision**: "circulation" (verb "circulate"),
  used everywhere in code, copy and URLs. A circulation is created from a
  worksheet, carries its own copy of the questions, gains recipients over time
  and is where the sender watches progress.
- **Response**: one recipient's answers to one circulation.
- **Review**: the staff-only notes, scores and draft feedback about one
  response. Feedback that is returned is copied onto the response.
- **Staff** of a circulation: the sender, the reviewers the sender named, the
  worksheet's author, and admins. Stored as `staffUids` on the circulation
  because every rule and every list query keys off one array.
- **Recipient**: a person a circulation was sent to. Recipients are committee
  members today. Nothing in the model requires that: a recipient is a
  response document and a task, whatever their role.

## Permissions

| Action | Who |
| --- | --- |
| Open the library, create and edit own worksheets, create folders | any `committee` member (SU-recognised or not) and admins |
| Delete a library worksheet | its author or an admin, through the route; refused while a circulation of it is open |
| Destroy a circulation, destroy an admission round | admins only, never the sender (see Deletion) |
| Edit somebody else's worksheet | admins only (**Decision**; others use "Make a copy") |
| Make a worksheet private | admins only; a private worksheet is listed for admins and its author |
| Circulate, add recipients | holders of the new `permissions.circulateWorksheet` key, admins implicitly |
| Edit a circulation's copy of the questions mid-flight, review, return feedback, export | the circulation's staff |
| Answer | the recipient, their own response only |
| Unfreeze a submitted response | admins only |
| Read responses | staff; a recipient reads only their own |
| Read scores | staff only, never the recipient |

`circulateWorksheet` sits in `users.permissions` beside `draftEvent` and
friends. It is granted per person by an admin and is not automatic for
SU-recognised committee. The recipient picker does not read the `users`
collection; it calls `GET /api/worksheets/recipients`, which requires the key
and returns committee members' uids, display names and photos only, so the key
is sufficient on its own and the users-collection rule is untouched
(**Decision**).

## Data model

Types live in `src/lib/firestore/worksheets.ts` and
`src/lib/firestore/circulations.ts`, which are authoritative. Summary:

```
worksheets/{worksheetId}
  title, description, folderId | null, authorUid, private (bool),
  items: WorksheetItem[], defaultReviewConfig, createdAt, updatedAt,
  lastCirculatedAt | null

worksheetFolders/{folderId}
  name, createdByUid, createdAt

circulations/{circulationId}
  worksheetId, title, description, items (the semi-frozen copy),
  senderUid, authorUid, reviewerUids[] (max 5), staffUids[],
  reviewConfig, notifications, dueDate | null, status ("open" | "closed"),
  anonymity ("named"), source { kind: "worksheet" },
  recipientCount, submittedCount, reviewedCount,
  itemsEditedAt | null, createdAt, updatedAt, closedAt | null

circulations/{circulationId}/responses/{uid}
  uid, circulationId, taskId, state, answers, progress, activity,
  submittedAt, reviewedAt, returned | null, unfrozenAt, unfrozenByUid,
  addedAt, addedByUid, updatedAt

circulations/{circulationId}/reviews/{uid}      (staff only)
  perQuestion { [questionId]: { feedback?, score? } }, overall,
  updatedAt, updatedByUid

tasks/{taskId}                                    (one per recipient)
  source "worksheet", kind "worksheet", visibility "assignees-only",
  completerUids [uid], reviewerUids = circulation.reviewerUids,
  artefact { kind: "worksheet-response", circulationId }
```

Two collections arrived with the deletion work. Neither is worksheet-specific:
they are shared by every destroy this repo has that is not a course. See
Deletion below, and the two modules named there, which are authoritative.

```
memberRecords/{uid}                               (routes write, nobody else)
  uid, updatedAt

memberRecords/{uid}/applications/{roundId}
  roundId, roundTitle, roundKind, appliedFor[] (human labels),
  appliedAt, submittedAt,
  outcome { decision, status, targetRunId },
  scoreSummary { reviewerCount, total, mean, byCriterion },
  reviewerNotes[] { reviewerUid, reviewerName, recommendation, total, notes },
  writtenAt, writtenBy ("settle" | "destroy" | "backfill"), writtenByUid
  Read: admin + SU-recognised committee. Write: routes only, and account
  deletion keeps it.

destroyAudits/{id}                                (routes write, admin reads)
  kind ("circulation" | "admission-round", plus a reserved "worksheet"
    that nothing writes), targetId, label,
  startedAt, startedByUid, startedByName, deleted { <stage>: n },
  completedAt | null, resumeCount, passInFlightUntil | null
  A null completedAt IS an interrupted destroy.
```

### Items

```ts
type WorksheetItem = WorksheetQuestion | WorksheetSection | WorksheetPageBreak;

type WorksheetQuestion = {
  kind: "question";
  id: string;
  type: "shortText" | "longText" | "singleChoice" | "multipleChoice"
      | "poll" | "rating" | "imageUpload";
  title: string;            // plain text, always present, the CSV header
  body: Block[];            // richText, image and video blocks only
  required: boolean;
  limit?: { unit: "characters" | "words"; max: number };   // text types
  options?: { id: string; label: string; imageUrl?: string; imageStoragePath?: string }[];
  rating?: { max: number; minLabel?: string; maxLabel?: string };  // 1..max
  poll?: { resultsVisibility: "staff" | "before-submit" | "after-submit" };
  upload?: { maxImages: number };                            // 1..4
};
type WorksheetSection = { kind: "section"; id: string; heading: string; body: Block[] };
type WorksheetPageBreak = { kind: "pageBreak"; id: string };
```

A poll is a single-choice question whose aggregate has an audience setting.
Options carry ids so a reviewer fixing a typo in a label mid-flight does not
orphan every answer already given. `Block` is the shared block type from
`src/lib/firestore/newsletterBlocks.ts`, which gained Loom alongside YouTube
in the video block.

### Answers

```ts
type WorksheetAnswer =
  | { type: "text"; text: string }                       // shortText, longText
  | { type: "choice"; optionId: string }                 // singleChoice, poll
  | { type: "choices"; optionIds: string[] }             // multipleChoice
  | { type: "rating"; value: number }
  | { type: "images"; images: { url: string; storagePath: string }[] };
```

`progress` is `{ answered, total, requiredAnswered, required }`, written by
the recipient's client on every autosave and re-derived by the submit route.
It drives the progress bars and is cosmetic; the route is the authority.

### Response states and the task

| Response `state` | Task `status` | How it moves |
| --- | --- | --- |
| `not-opened` | `todo` | written at send time |
| `started` | `in-progress` | the recipient's client, on first open (client-direct, both docs) |
| `submitted` | `review` if `reviewConfig.returnToRecipient`, else `done` | `POST .../submit` |
| `reviewed` | `done` | `POST .../responses/{uid}/return` |
| back to `started` | `in-progress` | `POST .../responses/{uid}/unfreeze`, admin only |

A submitted or reviewed response is frozen: the rules refuse the recipient's
writes unless `state` is `not-opened` or `started`. Unfreeze is the only way
back and it is an admin action.

The task carries no subtasks and no blocks. **Decision**: the per-block
reviewer signoff and lock-in ritual are not used; a worksheet task has one
completer and its Done is decided by the worksheet lifecycle above, so
forcing it through allocation and consent would be ceremony with no
participants. The task detail modal renders a worksheet panel in place of the
subtask section when `task.artefact.kind === "worksheet-response"`.

`artefact` is a new nullable field on `TaskDoc`, a discriminated union with
one member today. It is where an event or a newsletter section would hang
when those become subtasks; `Subtask` reserves the same optional field.
Nothing client-side may write it: it is outside the completer band in the
task rules and worksheet tasks are `assignees-only`, so the committee lane
never reaches them.

### Activity tracking

`activity: { firstOpenedAt, pageOpens, activeMs, lastActiveAt }` on the
response. The recipient's client stamps `firstOpenedAt` once, increments
`pageOpens` on every page change, and adds to `activeMs` every 30 seconds
while the tab is visible and the person has moved or typed in the last
minute. No keystrokes, no paste events, no per-question timing. Shown to
staff on the circulation page and to the recipient on their own task and
respond page ("You first opened this on ..."). The privacy notice carries a
line for it; see the OWNER TO CONFIRM item in `src/content/legal/privacy/v4.tsx`.

## Firestore rules

New blocks in `firestore.rules`, in this order after `taskTemplates`:

- `worksheets/{id}`: read for committee-or-admin when `private == false`, or
  admin, or author. Create for committee-or-admin with `authorUid == self`,
  `private == false` unless admin, `title.size() <= 120`,
  `items.size() <= 100`. Update by admin or author with `authorUid` pinned
  and `private` pinned unless admin. NO client delete, for anybody, because a
  document delete strands the question images in Storage and cannot ask whether
  a circulation is still open; deletion is `DELETE /api/worksheets/{id}` (see
  Deletion).
  A committee member's library list must carry `where("private", "==", false)`
  or Firestore refuses the whole listen (shape rule); admins list unfiltered.
- `worksheetFolders/{id}`: read, create, update, delete for
  committee-or-admin; `name.size() <= 60`.
- `circulations/{id}`: read if admin, `uid in staffUids`, or a response
  document exists at `responses/{uid}` (the recipient's proof, one `exists()`
  per get). No client create or delete. Update by admin or staff, keys
  limited to `title, description, items, reviewConfig, notifications, dueDate,
  itemsEditedAt, updatedAt`, `items.size() <= 100`. Everything else
  (`staffUids`, `reviewerUids`, counters, status) is written by routes.
  Staff lists must carry `where("staffUids", "array-contains", uid)`.
- `circulations/{id}/responses/{uid}`: read if `uid == self` or parent staff
  (path-based `get()` of the parent, the tasks/comments pattern). No client
  create or delete. Update only by the recipient, only while stored `state`
  is `not-opened` or `started`, keys limited to `answers, progress, activity,
  state, updatedAt`, new `state` in the same two values,
  `answers.size() <= 100`.
- `circulations/{id}/reviews/{uid}`: read, create, update by parent staff;
  keys `perQuestion, overall, updatedAt, updatedByUid`;
  `overall.size() <= 4000`; delete by admin.

`hasPerm('circulateWorksheet')` is added beside `canDraftCourse` for
completeness, though no rule keys off it in v1 (circulating is a route).

## Storage

Two new paths in `storage.rules`:

- `worksheet-images/{ownerId}/{image=**}`: question bodies and option images.
  Read for any signed-in user; write for committee-or-admin, under 5 MB,
  `image/*` and not `image/svg+xml`. `{ownerId}` is a worksheet id or a
  circulation id, so there is no single document to scope ownership on
  (the course-images reasoning), **Decision**.
- `worksheet-uploads/{circulationId}/{uid}/{file}`: image answers. Read for
  the recipient, the circulation's staff and admins; **no client write**. The
  file goes through `POST /api/worksheets/circulations/{id}/upload`, which
  checks the magic bytes (PNG, JPEG, GIF, WebP; SVG refused), enforces the
  5 MB cap after the client's `browser-image-compression` pass, writes with
  the Admin SDK, sets a download token and returns `{ url, storagePath }`.

There is **no virus scanner** in v1. Uploads are re-encoded on the client,
type-checked on the server, and never served inline to anyone but staff and
the uploader.

Both paths are cleared by deletion, and by nothing else. `worksheet-images/{id}`
goes with the worksheet or the circulation it belongs to, except that a
worksheet's folder is KEPT while any circulation of it exists, because those
copies point at the same files (see Delete a library worksheet);
`worksheet-uploads/{circulationId}` goes with the circulation. Neither can be
cleared client-side, because Storage rules cannot cascade from a Firestore
delete, which is the reason both deletions are routes (see Deletion).

## Indexes

One composite index: `circulations (status ASC, dueDate ASC)`, for the
due-soon reminder job's scan: `status == "open"` and `dueDate` between the
start of today in London and sixty days out (the furthest a reminder slot may
be set from its due date, so nothing beyond it can have a reminder owed). The
lower bound is the start of the London civil day rather than `now`, so a
worksheet due at 09:00 with a nudge set for 08:00 is still reminded at 08:05.
Which slots are actually due is decided in code, from each circulation's own
list. Every other query is equality-only or sorted client-side.

## Routes

All under `src/app/api/worksheets/`, a tree registered in
`tests/impersonation-guard.test.mjs` so every mutating handler calls
`assertNotImpersonating()` first.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/worksheets/recipients` | `circulateWorksheet` | committee roster for the picker: uid, displayName, photoURL, role |
| `POST /api/worksheets/circulations` | `circulateWorksheet` | copies the worksheet, writes the circulation, one response doc and one task per recipient (batched), sends "assigned" if enabled |
| `POST /api/worksheets/circulations/{id}/recipients` | `circulateWorksheet` and staff | adds recipients to an open circulation, same per-recipient writes; existing recipients are skipped |
| `POST /api/worksheets/circulations/{id}/submit` | the recipient | validates required questions and limits against the circulation's copy, moves the response to `submitted` in a transaction, moves the task, bumps `submittedCount`, notifies reviewers |
| `POST /api/worksheets/circulations/{id}/upload` | the recipient | multipart image answer upload, see Storage |
| `POST /api/worksheets/circulations/{id}/responses/{uid}/return` | staff | copies feedback from the review doc onto the response (never scores), state `reviewed`, task `done`, notifies the recipient |
| `POST /api/worksheets/circulations/{id}/responses/{uid}/unfreeze` | admin | state back to `started`, task `in-progress`, counters adjusted |
| `POST /api/worksheets/circulations/{id}/export` | staff | CSV of every response, logged to `dataExports` as kind `worksheet-responses` with scope `{ circulationId }` |
| `GET /api/worksheets/circulations/{id}/aggregate` | recipient or staff | counts per option for a poll question, honouring `resultsVisibility` for recipients; never names |
| `POST /api/worksheets/circulations/{id}/close` | staff | `status: "closed"`, archives every recipient task; no further submissions |
| `DELETE /api/worksheets/{worksheetId}` | author or admin | deletes the library document, and its question images when the worksheet has never been circulated; refused while a circulation of it is open |
| `GET /api/worksheets/circulations/{id}/destroy-manifest` | admin | what a destroy would remove, plus blockers and any interrupted pass |
| `POST /api/worksheets/circulations/{id}/destroy` | admin | the cascade; typed `confirmName`, resumable, audited |

Routes cap recipients per request at 100 and write in batches of 200 documents.

## Notifications

Per circulation, set by the sender, each with an email and a push switch:

| Event | To | Template |
| --- | --- | --- |
| `assigned` | new recipients | `TaskMembershipEmail` (reused) |
| `dueSoon` | recipients not yet submitted | `WorksheetDueSoonEmail` (new), sent by the scheduler job |
| `submitted` | reviewers | `TaskReviewRequestEmail` (reused) |
| `feedbackReturned` | the recipient | `WorksheetFeedbackEmail` (new) |
| `copyEdited` | recipients who have started but not submitted | `WorksheetUpdatedEmail` (new); **Decision**: added because a mid-flight edit the recipient never hears about is the one surprise this feature can spring |

Every send goes through `sendEmail` with `kind: "task"`, honours the
`config/taskEmails` kill switch, and mirrors to push through
`mirrorTaskEmailToPush` under the existing `tasks` preference, with the push
deep-linking to the respond page rather than the board.

`dueSoon` carries a SCHEDULE beside its two switches:
`notifications.dueSoon.slots`, a list of up to six
`{ id, daysBefore, atLocalTime }` entries counted back from `dueDate` in
London civil days (`src/lib/reminders/slots.ts`, shared with the admission
rounds). Defaults are three days out and the day before, both at 10:00, and a
circulation stored without a list reads as those defaults, so nothing written
before the list existed fell silent. The list lives inside `notifications`
because the staff update band in the rules already allows that key and
constrains nothing inside it: the schedule shipped with no rules change and no
deploy. The switches remain the on and off.

`dueSoon` is the one exception to "push mirrors email, and never leads it".
Its two switches are independent, so a circulation with the email switch off
and the push switch on sends a push and no email. That is the owner's ask (a
switch per channel per event) and it is safe there because the scheduler job's
unit of work is one person's reminder rather than a broadcast, and its marker
records what happened to that person on either channel. Everything sent from
`src/lib/worksheets/notify.ts` still mirrors and never leads; the divergence
lives in `src/lib/scheduler/jobs/worksheetDueReminders.ts` alone, and the
site-wide `config/taskEmails` kill switch still covers the push.

Due-soon reminders are the scheduler job `worksheet-due-reminders`, registered
with `enabledByDefault: false`, so it ships dark until an admin turns it on
from the scheduler panel (and until `SCHEDULER_SECRET` exists, the tick
cannot run at all). Markers are `wsremind__{circulationId}__{uid}__{dueKey}`,
where `dueKey` is the London civil date a slot resolved to WITH its wall clock
(`2026-10-04T1000`): two slots on one day at different times are two
reminders, two resolving to one moment are one, and moving the due date
re-resolves every slot and mints new keys. A slot further past its moment than
the job's `maxLateHours` is dropped and counted on the run, with no marker
written, because on a later tick a passed slot is normally one that went out
on time. The circulation page shows admins a one-line notice beside the
due-soon switch saying reminders are not yet live.

## Review and feedback

`reviewConfig` is four independent toggles, defaulted from the worksheet and
set per circulation: `perQuestionFeedback`, `perQuestionScoring`,
`overallFeedback`, `returnToRecipient`. Staff write feedback and scores
client-direct to the review doc as they go. "Return to recipient" is a route
that copies the feedback the toggles allow onto the response and freezes it.
Scores are never copied. With `returnToRecipient` off the response is frozen
on submit, the task is green, and the recipient can read but not change their
answers.

## Views

- **Library** `/worksheets`: folders, worksheets, "Sent" tab listing the
  viewer's circulations.
- **Editor** `/worksheets/{worksheetId}`: title, description, folder, items
  with drag and drop plus up and down arrows, per-question settings, section
  headings, page breaks, the Circulate button.
- **Circulation** `/worksheets/{worksheetId}/circulations/{circulationId}`:
  one row per recipient with progress bar, state, activity, and click-through
  to that person's responses; add recipients; notification and review
  toggles; edit the copy; aggregate view; export; close.
- **Respond** `/worksheets/respond/{circulationId}`: the recipient's pages
  with a progress bar, autosave per answer plus a Save button whose spinner
  goes solid green when saved, submit, and afterwards the read-only view with
  any returned feedback.
- **Task board**: a worksheet task shows a Worksheet badge on its card and a
  worksheet panel in the detail modal.

The respond page renders questions with its own `WorksheetQuestionField`
rather than the events `FormRenderer`. **Decision**: FormRenderer keys choice
answers by option label, has no rich bodies, no option images, no poll,
rating or upload types, and is the mobile-frozen RSVP baseline; extending it
would have put every one of those onto the RSVP flow. The worksheet field
reuses the same primitives (`CountedTextarea`, `ResponsiveSelect`) and the
FormRenderer stylesheet so the two look like one system.

## What a course would need

The model was shaped so a fellowship exercise or an incubator brief can adopt
it without a rewrite:

- `circulation.source` becomes `{ kind: "course-exercise", runId, weekId }`;
  the discriminator exists today with one member.
- Staff would be the run's facilitators; recipients the active enrolments;
  the recipients route would take a run id instead of a uid list.
- The respond page, the response model, the review model and the export need
  no change. The task per recipient is optional there: `taskId` may be null.
- An anonymous mode would add `anonymity: "anonymous"`, keep responses keyed
  by uid for the rules, and add a server-only pseudonym map; nothing reads
  `anonymity` today except to assert it is `"named"`.

## Out of scope in v1

Events and newsletter sections as subtasks; a member task board for
non-committee recipients; anonymous responses; a virus scanner; per-question
time tracking; an edit lock for two reviewers editing one copy (admins
coordinate through `useAdminPageLock`, which `adminLocks` rules restrict to
admins, so for non-admin reviewers the last write wins and the page says so).

## Configurable reminders (landed)

Asked for by the owner on 7 September 2026 and built to the shape recorded
here. The due-soon job used to remind every unsubmitted recipient once, 48
hours before the due date, and an admission round had three fixed reminder
ids whose names said seven, three and zero days while their numbers were
editable. Both now share one shape:

- A free list of slots, `{ id, daysBefore, atLocalTime }[]`, capped at six and
  at sixty days out, defined once in `src/lib/reminders/slots.ts` with one
  sanitiser, one validator and one derived label, so an edited slot cannot
  wear the wrong name. A circulation stores its list at
  `notifications.dueSoon.slots` (inside `notifications` on purpose: the staff
  update band in the rules already allows that key and constrains nothing
  inside it, so no rules change and no deploy); a round keeps its list in
  `reminderOffsets`, the field name it already had. Defaults are code
  constants: three days and one day out at 10:00 for a worksheet, and the
  round's three old presets. Both are editable in place, the circulation's in
  the Circulate dialog and the Settings tab, through one editor
  (`src/features/reminders/SlotListEditor.tsx`).
- One resolver, `src/lib/reminders/schedule.ts`, lifted out of the admissions
  module so both jobs derive their due instants from the same arithmetic:
  London civil days, the slot's own wall clock, a slot resolving past its
  anchor dropped, and lateness measured from the slot rather than from any
  window. The admissions module keeps its exported names over the top of it.
  Admissions groups slots by DAY (two on one date are one email to an
  applicant pool); worksheets group by INSTANT, so a sender who sets 09:00 and
  16:00 on the due day gets both.
- Both remain dark until the scheduler runs; the switches gate what is sent
  once it does.

Two consequences a sender can see, named here because neither is obvious from
the editor:

- **Lateness is per slot, so a very late addition can miss out.** The old
  worksheet rule reminded anybody unsubmitted at any point in a 48-hour window,
  which is why it also silenced every deadline under a day away. The rule now
  is that each slot is worth sending for 24 hours after its own moment and not
  after, so somebody added to a circulation after the last slot has passed gets
  no reminder at all. With the defaults that gap is roughly the final 14 hours
  before the deadline. The answer is a slot on the due day, which a sender can
  now add; recipients are added over time on this feature, so it is the change
  most likely to surprise.
- **A slot cannot land after the date it counts back from.** A worksheet due at
  09:00 with "on the due date at 12:00" would resolve three hours after the
  deadline, and the resolver drops it rather than sending a reminder about a
  deadline that has gone. Only a 0-day slot can manage it, and the editor says
  so on the offending row rather than letting the sentence look scheduled.
- **A reminder whose moment has passed is dropped quietly.** The run counts and
  logs one only while it has just passed the 24-hour bound. A slot stays
  resolvable until its circulation leaves the scan, so a reminder delivered on
  time reads as "past" on every tick for days afterwards, and reporting each of
  those filled the log and showed the scheduler panel a busy job on ticks that
  wrote nothing. Whether the scheduler has been dark is answered by its own
  last-run time.

## Deletion (landed)

Built to the shape the owner asked for on 7 September 2026. Nothing used to
delete worksheet or admissions data: a worksheet and a circulation could not be
removed, account deletion left a member's responses in place, and an admission
round could be cancelled but never removed. The courses destroy protocol
already had a manifest, blockers, an audit row and a typed confirmation, so
this copies that shape rather than inventing a fourth.

### The rule above all of it

**A destroy never deletes what the committee wants to remember about a
person.** That is the owner's instruction and it is what the member record
(below) exists for. A round destroy writes any missing record entry FIRST and
refuses if that write fails, so the safeguard is a precondition of the cascade
rather than a step inside it.

**No destroy sends email.** Not to a recipient whose responses are going, not
to a reviewer, not to an applicant. A destroy is for a test round, a mistake or
a clean-up, and telling forty people that something they did has been removed
turns an admin's tidy-up into an incident.

### The member record

`memberRecords/{uid}/applications/{roundId}`: per person, when they applied,
what for, the outcome, how they scored and the reviewers' notes, copied as
plain text. Written when a round settles, or by a round destroy that finds an
entry missing, whichever comes first. Shape and reasoning in
`src/lib/firestore/memberRecords.ts`, which is authoritative; the summary in
the data model block above is a summary.

- **Read**: admins and SU-recognised committee, the same trust boundary the
  `users` collection draws, because an entry is roster-tier knowledge about a
  member. Reading it is the point of writing it: a later application is meant
  to be graded with this history in view.
- **Not an own-row read.** A member cannot read their own entry. It holds the
  reviewers' notes verbatim, and the round's own rule is that those are
  disclosed on request rather than streamed to their subject from a browser
  console.
- **Write**: routes only, admins included. An entry copies other people's
  writing out of `admissionReviews`, it has one correct derivation
  (`buildApplicationRecord`), and it outlives its sources, so nothing can check
  it after the fact.
- **Account deletion keeps it**, and the deletion summary counts what it kept.
  Same reasoning as the export log: it is the committee's record of its own
  decisions rather than the member's content. It carries no essay answers, no
  availability grid, no access-requirements answer and no email address.
- **Participation notes** (how a member has taken part since) are a later
  slice. They hang as a sibling subcollection under the same parent, because
  they are not about one round and they accrue on their own schedule.
  `memberConductFlags` is the precedent for admin-authored notes about a
  member, and this read tier is deliberately wider than that one: a conduct
  flag carries an allegation, an entry here carries a decision.

### The destroy audit

`destroyAudits/{id}`: one row per destroy attempt for every cascade that is not
a course, opened BEFORE the first delete and stamped `completedAt` at the end,
so a row with a null `completedAt` is durable evidence of an interrupted
destroy. Admin read, no client write at all, on the `courseDeletions` posture
and for its reasons: this log is the only surviving evidence of a destroy,
because the rows it describes are gone.

Two kinds write rows: `circulation` and `admission-round`. A worksheet delete
writes NOTHING here, so an absent row is not evidence that nobody deleted a
worksheet. That is the one deletion in this wave with no manifest, no resume and
no audit, on the grounds that it is a single confirm over a document whose
circulations each keep their own copy of the items. `worksheet` is reserved in
the union so that recording it later is a two-line change in the route rather
than a migration, and the module says as much next to the union.

It is a SECOND collection rather than a `kind` field on `courseDeletions`
because the course protocol's other half is a marker stamped on the course or
run document itself, and a circulation, a worksheet and an admission round have
no such field and no reason to grow one. `src/lib/firestore/destroyAudit.ts`
carries the full argument, and the resume shape that follows from it: no
marker, so an interrupted pass is found with an equality-only query and a
client-side pick rather than with an index.

### Delete a library worksheet

Author or admin, one typed confirm, no manifest. Refused while any circulation
of it is open, and the blocker is named in the confirm.

`DELETE /api/worksheets/{worksheetId}` does it, and the client delete is now
`allow delete: if false` for everybody. A document delete is not the whole
deletion: the question and option images live in Storage under
`worksheet-images/{worksheetId}` and rules cannot cascade, and "is there an open
circulation of this worksheet" is a cross-collection question rules cannot ask.
The `events` collection is the precedent (`src/app/api/events/[id]/delete`).
The author is still the person who may delete it; that permission moved into
the route, where it can be enforced together with the other two checks.

The question images are swept ONLY when no circulation of the worksheet exists,
whatever its status. A circulation copies the items verbatim, and an image in
that copy points into `worksheet-images/{worksheetId}` until somebody re-uploads
it on the circulation's own copy, so emptying the folder would blank the pictures
inside every circulation ever made from this worksheet, archived ones included.
The delete keeps the folder instead and reports how many files it kept. The cost
is an orphaned folder once those circulations are themselves destroyed (a scan
job, and the same one uploads already need); the alternative was an unrecoverable
hole in the record of what people were asked.

No `destroyAudits` row is written, unlike the two destroys below (see The
destroy audit). Closing the client delete also does not make the question images
safe on its own: an author can still strand the same files by editing the items
list, which nothing sweeps.

### Destroy a circulation

Admins only, never the sender (**owner decision**). Typed confirm, with a
manifest first. `GET .../destroy-manifest` then `POST .../destroy`.

Deletes: responses, reviews, the recipient tasks with their comments, activity
and attachments through the existing task cascade, the copy's question images,
every uploaded answer image under `worksheet-uploads/{circulationId}`, and the
circulation's scheduler markers. Counted and RETAINED: `dataExports` rows and
`emailSends` rows, as every other destroy does, because each is evidence about
something that has already left the platform.

Manifest count keys: `responses`, `reviews`, `tasks`, `uploadedImages`,
`questionImages`, `schedulerMarkers`, `dataExportRows` (retained),
`emailSendRows` (retained).

The two image counts are the only ones that can be MISSING from a manifest. A
bucket listing that fails is not reported as 0, because "no uploaded answers" and
"the file store did not answer" would then read identically on the last screen
before an irreversible action: the key is left out and a blocker sentence says
the folder could not be counted. A fresh destroy re-checks the same thing and is
refused too, so a request made without reading the manifest cannot get past it.

The audit row carries one key the manifest does not: `circulation: 1`, added
when the circulation document itself goes, as the round destroy adds `round: 1`.
Neither is a manifest key, because a manifest is a forecast of what a destroy
would remove and the target itself is not news. On the audit row they are the
line that says the cascade got all the way to the end.

### Destroy an admission round

Admins only, offered straight away, with the confirm and the manifest as the
safeguard (**owner decision**: no "cancel it first" gate). Cancelling is still
the normal way to end a round; destroy is for test rounds and mistakes.

Deletes: the round, its stages, its applications and their private parts, and
its reviews. Releases the `admissionsReviewer` flag on people who review
nothing else. WRITES FIRST: any missing member-record entry, counted on the
manifest as `memberRecordEntriesWritten`, which is a count of writes made
rather than of rows destroyed. The destroy refuses if that write fails.

Manifest count keys: `applications`, `applicationPrivateRows`, `reviews`,
`stages`, `memberRecordEntriesWritten` (written, not deleted),
`reviewerFlagsCleared`, `emailSendRows` (retained), `dataExportRows`
(retained).

### Account deletion

Keeps responses and reviews, as it keeps tasks, and counts them in the deletion
summary so the policy can be reversed knowingly. Authored worksheets stay in
the library with their author shown as a former member. The member record is
kept too, and counted, for the reason given above.

### The manifest and the confirm

One JSON shape for every destroy, so one panel renders all of them
(`src/features/destroy/DestroyPanel.tsx`, the generic half of
`RunDangerZone`): `{ target: { id, label, context, status }, counts, blockers,
interrupted }`. Each destroy route takes `{ confirmName }` and returns
`{ ok, deleted, complete, auditId }`. A blocker is a 409 with the sentences
intact, a pass already running is a 409, a wrong `confirmName` is a 400.
`complete: false` means the pass ran out of budget and the SAME call resumes,
which is why the panel shows a running total taken from the audit row rather
than from the pass.
