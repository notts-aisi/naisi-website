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
line for it; see the OWNER TO CONFIRM item in `src/content/legal/privacy/v3.tsx`.

## Firestore rules

New blocks in `firestore.rules`, in this order after `taskTemplates`:

- `worksheets/{id}`: read for committee-or-admin when `private == false`, or
  admin, or author. Create for committee-or-admin with `authorUid == self`,
  `private == false` unless admin, `title.size() <= 120`,
  `items.size() <= 100`. Update by admin or author with `authorUid` pinned
  and `private` pinned unless admin. Delete by admin or author.
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

## Indexes

One composite index: `circulations (status ASC, dueDate ASC)`, for the
due-soon reminder job's `status == "open" and dueDate in [now, now + 48h]`
scan. Every other query is equality-only or sorted client-side.

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

Due-soon reminders are the scheduler job `worksheet-due-reminders`, registered
with `enabledByDefault: false`, so it ships dark until an admin turns it on
from the scheduler panel (and until `SCHEDULER_SECRET` exists, the tick
cannot run at all). Markers are `wsremind__{circulationId}__{uid}__{dueKey}`.
The circulation page shows admins a one-line notice beside the due-soon
switch saying reminders are not yet live.

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
