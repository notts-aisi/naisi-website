@AGENTS.md

# NAISI website

University of Nottingham AI Safety Initiative — public marketing site + authed committee tooling.

## Stack

- **Next.js 16 App Router** + **TypeScript** + **React 19**
- **Firebase**: Auth (Google Sign-In), Firestore, App Hosting (Cloud Run under the hood)
- No UI library — CSS Modules + theme tokens in `src/theme/tokens.css`

## Next 16 specifics (easy to get wrong from training data)

- **`middleware.ts` is now `proxy.ts`** — lives at `src/proxy.ts`. Same behaviour, different name.
- Route params are Promises: `{ params }: { params: Promise<{ slug: string }> }`, must `await` them.
- Route handlers can use typed `RouteContext<"/api/foo/[id]">` helper.
- `generateMetadata` is streamed but paused for bot user-agents (great for social previews).
- Firebase App Hosting, not classic Firebase Hosting — see `apphosting.yaml` (base config). Per-environment overrides live on each backend as UI env vars in the Firebase console, not in separate yaml files (that mechanism doesn't exist in current App Hosting).

## Project layout

```
src/
├── app/                              # App Router routes
│   ├── (public)/                     # Marketing — PublicHeader + PublicFooter layout
│   │   ├── members/  resources/  news/[slug]/
│   │   └── events/[id]/              # public event page + RSVP flow
│   │                                 #   (rsvp/[rsvpId]/{change,cancel}, rsvp/submitted)
│   ├── (auth)/                       # login/register/pending-approval (minimal layout)
│   ├── (app)/                        # Authed area, server-side role-gated in its layout.tsx
│   │   ├── dashboard/  profile/  tasks/     # member-facing ("My work")
│   │   ├── committee/tasks/                 # committee task board
│   │   ├── worksheets/                      # worksheet library, editor and circulation
│   │   │                                    #   pages (committee); respond/[id] for recipients
│   │   ├── credentials/                     # placeholder page — feature not built
│   │   ├── newsletter/  events/manage/      # drafter / approver tools
│   │   └── admin/                           # gated trees, see "Admin area gating":
│   │       ├── (admin-only)/                #   full admins: Approvals, Members, Projects,
│   │       │                                #   Newsletter, Subscriptions, Email designs,
│   │       │                                #   Deliverability, Task templates, Danger zone
│   │       └── courses/                     #   admins + draftCourse/approveCourse holders
│   ├── verify-email/[tokenId]/       # uni-email magic-link landing
│   └── api/                          # session, admin/*, events/*, tasks/*, worksheets/*, newsletter/*,
│                                     #   subscriptions/*, verify-email/*, webhooks/*, …
├── auth/                             # AuthProvider, signInWithGoogle, completeRegistration
├── components/                       # BrandMark, SubscribeForm, ReadingListAccordion
│   └── ui/                           # Button, Card, Badge, Input, Select, Switch,
│                                     #   SegmentedControl, ProgressBar, DateTimePopover,
│                                     #   TimeField, StatusSelect, GraduationSelect, CountedTextarea
├── emails/                           # JSX email templates (newsletter, RSVP, task, application, …)
├── features/                         # admin, events, members, news, newsletter, profile, tasks
├── layout/                           # PublicHeader, PublicFooter, AppShell
├── lib/
│   ├── firebase/                     # client.ts, admin.ts, session.ts
│   ├── firestore/                    # typed per-collection helpers (one file per collection)
│   ├── email/  events/  sns/         # send helpers, ICS, RSVP tokens, SNS verify
│   └── csv.ts, signedTokens.ts, obfuscateEmail.ts, …
├── theme/                            # tokens.css, typography.css
└── content/                          # static data (socials, resources, readingLists)
```

## Conventions

- **Theming**: every colour/spacing/radius reads from a CSS var in `src/theme/tokens.css`. Swapping palette = editing one file. `data-theme="light"` on `<html>` flips to light mode.
- **Brand mark**: `src/components/BrandMark.tsx` renders the real castle + shield + head emblem. All site surfaces sit on the dark theme, so it uses the monochrome white export. Favicon lives at `src/app/icon.png` + `src/app/apple-icon.png` (Next 16 app-router convention). The master logos live in `brand-source/` (not served); `scripts/generate-brand-assets.mjs` regenerates every derivative in `public/brand/` + `src/app/` — re-run it if a master logo changes.
- **Client vs server components**: public pages lean server-side (SSR + `generateMetadata` for OG tags). Authed pages are client components so real-time Firestore `onSnapshot` works. `(app)/layout.tsx` is a Server Component that role-gates with `getCurrentUser()`.
- **Two-layer auth gate**: `src/proxy.ts` does a fast session-cookie presence check on protected routes. Real role enforcement happens in `(app)/layout.tsx` via `getCurrentUser()` (Admin SDK, reliable).
- **No `orderBy` on sparse fields**: Firestore drops docs missing the ordered field. Query without orderBy, sort client-side, or only orderBy on fields that are *always* present.
- **No `undefined` in `setDoc`**: Firestore refuses it. Use the `compact()` helper in `src/auth/signInWithGoogle.ts` before writing.
- **Main-area width — PR #11 (reverted 2026-04-21) + follow-up landed 2026-05-25**:
  `AppShell`'s `<main>` defaults to `max-width: 64rem` (1024px). A `.mainWide` per-route class bumps the cap to 100rem and is currently applied to `/committee/tasks`. The original PR #11 attempt was reverted because the sidebar was only `position: sticky` vertically — wide-content pages caused horizontal document scroll that orphaned the nav off the left edge.

  Follow-up that landed:
  1. Sidebar is now `position: fixed` (with `.main` pinned to `grid-column: 2` so auto-placement doesn't collapse it into the now-empty first track). Horizontal scroll — kanban-internal or document — can't orphan it.
  2. Kanban still contains its own horizontal scroll via `overflow-x: auto` + a `min-width: 0` chain on `.scroll`, `.kanbanOnly`, AND `.main` itself (the grid item — added 2026-05-26 in the FAB PR). Without `.main`'s `min-width: 0`, the grid track `1fr` (= `minmax(auto, 1fr)`) takes `auto` to mean kanban min-content (~88rem), so `.main` expands to ~1440px and `<body>` scrolls horizontally instead of the kanban scrolling internally. At desktop viewports the symptom was hidden by `.main`'s `max-width` cap; the 48-60rem band, where `.main` switches to `max-width: 100%`, exposed the bug. The `mask-image` right-edge fade was removed — it was reading as a shadow on the rightmost visible column rather than a "scroll for more" affordance, and the bottom scrollbar already signals scrollability.
  3. `.mainWide` `padding-right` is `var(--space-4)` (was `var(--space-10)`) so the board reaches close to the viewport's right edge.
  4. Sidebar gains a per-user **collapse**: hamburger in the brand row collapses; when collapsed, a top-right pill (NAISI brand link + hamburger) slides in from off-right in sync with the sidebar sliding off-left. Persisted to `localStorage` (`naisi.sidebar.collapsed`) — kept off cookies to sidestep PECR preference-cookie ambiguity. `prefers-reduced-motion` opt-out.

  Rule remains: **wide-data views must handle their own responsiveness** — internal scroll, collapsing columns, stackable layouts — don't expand the shell cap to dodge it.

## Data model (Firestore)

Each collection has a typed read/normalise helper in `src/lib/firestore/`. That
file is the authoritative shape; the map below is a summary, not a schema.

### Built and in use

```
users/{uid}             { uid, email, displayName, photoURL, role, profile,
                          title?, bio?, showOnMembers?, tracks?, permissions?,
                          suRecognised?, approvedAt?, approvedBy?, rejectedAt?,
                          rejectedBy?, createdAt }
  .profile              { preferredName, universityEmail?, status, statusOther?,
                          subject, expectedGraduation?, motivation, interests?,
                          notifications?, uniEmailVerifiedAt?,
                          universityEmailWasSuppressed?, universityEmailLockUntil? }
  .notifications        { channels: { gmail, uniEmail },
                          categories: { newsletter, events } }
  .permissions          { draftNewsletter?, approveNewsletter?,
                          draftEvent?, approveEvent? }     (admin-granted)
  .tracks               ("technical" | "governance")[]     (admin-set tags)
  .suRecognised         boolean                            (admin-set)
  legacy (read-compat only): profile.newsletter, profile.course, profile.year

projects/{id}           { name, leadUid, memberUids[], archived,
                          createdAt, updatedAt }

tasks/{id}              Kanban task. Subtasks grouped into ordered blocks with
                        sequential gating + per-block reviewer signoff. See
                        tasks.ts (TaskDoc) for the full shape: completerUids,
                        reviewerUids, status, visibility ("committee" |
                        "assignees-only"), blocks[], subtasks[], blockConsents,
                        source ("committee" | "fellowship-reminder" |
                        "personal" | "course-register" | "worksheet"),
                        kind, priority, dueDate, artefact (nullable pointer
                        to a linked artefact; today only
                        { kind: "worksheet-response", circulationId }), …
  tasks/{id}/comments     threaded comments with @mentions
  tasks/{id}/activity     append-only activity log
  tasks/{id}/attachments  attachment metadata (files in Storage)

taskTemplates/{id}      { name, description, kind, subtasks[],
                          defaultCompleterCount, createdByUid, … }

worksheets/{id}         Library document: { title, description, folderId,
                          authorUid, private, items[] (questions, sections,
                          page breaks), defaultReviewConfig, … }. Drafted
                          by any committee member; private ones are
                          admin-only plus the author. See docs/worksheets.md.
worksheetFolders/{id}   { name, createdByUid, createdAt }
circulations/{id}       One act of sending a worksheet: its own copy of
                          items, senderUid, authorUid, reviewerUids,
                          staffUids (the one array every rule keys off),
                          reviewConfig, notifications, dueDate, status,
                          counters. No client create or delete; staff edit
                          the copy client-direct. No roster array: the
                          recipients ARE the responses subcollection.
  circulations/{id}/responses/{uid}  one recipient's answers, progress,
                          activity and state; the recipient autosaves
                          client-direct while state is not-opened or
                          started; the submit route freezes it.
  circulations/{id}/reviews/{uid}    staff-only feedback and scores; scores
                          never reach the recipient. Returned feedback is
                          copied onto the response by a route.

newsletterDrafts/{id}   { subject, blocks[], bodyMarkdown (legacy backup),
                          status (draft|pending|approved|sent|rejected),
                          authorUid, reviewerNotes?, approvedBy?, sentAt?,
                          sentCount?, subscribersReached?, … }

events/{id}             { title, blocks[], startAt, endAt, location,
                          locationHidden, locationPublicText, visibility
                          ("public" | "members"), capacity, waitlistEnabled,
                          signupForm[], foodText?, dietaryTags?, posterUrl?,
                          coverBranding, coverLogoColor, coverStripSize,
                          coverLogoPosition, coverLogoScale, coverLogoX,
                          coverLogoY, coverLogoBackdrop, coverLogoShadow,
                          archived, status (draft|pending|approved|
                          published|rejected|cancelled), authorUid,
                          collaboratorUids[],
                          rsvpCount{Pending,Confirmed,Waitlisted}, … }

eventRsvps/{id}         { eventId, uid?, name, email, answers, status
                          (pending|confirmed|waitlisted|denied|cancelled),
                          synthetic, pendingAnswers?, decidedBy?,
                          signupSnapshot?, … }
                        Attendee PII - readable only by SU-recognised
                        committee + admins; all writes via the server route.

subscriptions/{id}      Junction collection — one row per (email, channel).
                        { email, channel, audience ("user" | "guest"),
                          audienceId, name?, confirmed, confirmedAt?,
                          subscribed, subscribedAt?, unsubscribedAt?, source, … }
                        doc-id: sub_<sanitisedEmail>__<channel>. `confirmed`
                        and `subscribed` are orthogonal axes (see subscriptions.ts).

subscriptionEvents/{id} Append-only audit log — one doc per subscription action.

news/{slug}             { title, tldr, bodyMarkdown, publishedAt, authorName,
                          coverImageUrl? }

applicationEmailTemplates/{id}   Admin-edited lifecycle email boilerplates
                                 (submitted / approved / rejected).

emailVerifications/{tokenId}     One doc per outstanding uni-email magic-link.
```

Server-only collections (Admin SDK writes, client rules fully locked):
```
emailSends/{id}         Append-only delivery log (powers the deliverability tab).
suppressedEmails/{id}   Bounce + complaint suppression list.
config/{doc}            Runtime config — task-email copy lives here.
impersonations/{id}     Audit log of admin "view as" sessions:
                          { actorUid, actorEmail, actorName,
                            targetUid, targetEmail, targetName, targetRole,
                            startedAt, endedAt, failed? }
                        One doc per (start, end) pair. Written by
                        /api/admin/impersonate{,/exit} via Admin SDK;
                        rules give admin read, all writes locked.
```

### Rules exist, feature not built

```
credentials/{id}        Committee credentials store (planned client-side
credentialsMeta/{id}      AES-GCM). Rules are deployed; no feature code yet —
                          /credentials is a placeholder page.
bookings/{id}           1-1 booking calendar. Read rule only; all client writes
                          are locked. No UI, no server route.
```

## Roles and access

### Governance role (mutually exclusive)

`pending | member | committee | admin | rejected`. Role-change rules:
- New users always start at `pending` (enforced in Firestore rules on create).
- Self-update must keep role unchanged (rule enforces).
- Only admins can change roles, promoting member → committee → admin and demoting back.
- First admin is seeded manually via the Firestore console (documented in README).

### `suRecognised` (committee sub-flag, shipped)

A boolean on `users/{uid}`, admin-set and locked against self-edits. It splits
the `committee` role in two:
- **SU-recognised committee**: committee members the Students' Union formally
  recognises. Trusted with member PII (`users` collection reads) and the full
  committee task board.
- **Non-SU committee**: scoped to the tasks they are explicitly added to. No
  member-roster reads, no board-wide task visibility.

Admins always have SU-recognised-equivalent powers. Moving a user off the
committee role clears `suRecognised`.

### `permissions` map (orthogonal to role, shipped)

`users/{uid}.permissions` is an admin-granted map, independent of governance
role: `draftNewsletter`, `approveNewsletter`, `draftEvent`, `approveEvent`,
`draftCourse`, `approveCourse`, `manageMembership`, `circulateWorksheet`.
Admins implicitly hold all eight. These gate the Newsletter, Events and
Course drafter tools, the membership console, worksheet circulation, and the
matching Firestore rules, so a plain `member` can be granted `draftEvent`
without being promoted to committee. `circulateWorksheet` is granted per
person and is not implied by SU recognition; it gates sending a worksheet and
the recipient picker route, never drafting.

### Admin area gating (four trees)

`/admin` is no longer one role check. `(app)/admin/layout.tsx` admits an admin
OR a holder of `draftCourse` / `approveCourse`, because those grants are
useless if their holder is bounced off `/admin/courses`. The real per-page
enforcement therefore sits one level down, in gated route trees whose layouts
call the helpers in `src/lib/firebase/pageGates.ts`. The two original trees
are described here; `admissions` (`requireAdmissionsPage()`) and `membership`
(`requireMembershipPage()`) landed with V3 and follow the same shape:

- `(app)/admin/(admin-only)/**` calls `requireAdminPage()`. Everything that is
  not course authoring lives here (Approvals, Members, Collaborators,
  Registrations, Projects, Newsletter, Subscriptions, Email designs,
  Deliverability, Task templates, Site status, Danger zone). The group name is
  in brackets, so it contributes nothing to the URLs.
- `(app)/admin/courses/**` calls `requireCourseAuthorPage()`, the same
  predicate the front door uses. Deliberately repeated: a subtree whose only
  protection is a level above it loses that protection silently the next time
  somebody widens that level.

`AdminTabs` takes `isAdmin` from the layout and renders only the sections the
caller may use, so a course drafter sees Courses and nothing else. A new admin
page dropped straight into `src/app/(app)/admin/` has no role gate of its own;
`tests/no-admin-gating.test.mjs` fails on exactly that.

The whole tree is also closed while an admin is in a view-as session: the
layout renders a notice instead of its children, because the course editors
below it save client-direct and would record the writes as the member. See
Admin "view as" below.

### `tracks` (admin tags, shipped)

`users/{uid}.tracks` is an admin-set array of `"technical" | "governance"` tags
noting which side(s) of the course programme a user aligns with. Private
(admin-only in rules), not a permission and not a leadership role.

### Admin "view as" (impersonation, shipped)

A debug tool on the admin Members page: each non-admin row has a "View as
{name}" button that signs the admin in as that member so the site renders
*exactly* what the member sees (sidebar tabs, page redirects, role-gated
content). Useful for reproducing reports like "the Events tab isn't showing
for me." **Full impersonation**: `request.auth.uid` becomes the target's,
so Firestore rules and every gate behave identically to the target signing
in themselves.

Trust + safety properties:
- Start gate (`POST /api/admin/impersonate`) uses `getCurrentUser()` and
  requires `role === "admin"`, same pattern as the existing admin
  delete-user route. Refuses self / admin / pending / rejected targets,
  and refuses nested impersonation if an `__impersonator` cookie is
  already set.
- Audit-first: writes the `impersonations/{id}` doc BEFORE minting the
  custom token, so a mint failure can't leave an untracked session
  in flight (mint-fail path closes the doc with `failed: true`).
- `__impersonator` cookie is httpOnly + secure-in-prod + sameSite=lax,
  carries `{ actorUid, actorName, actorEmail, auditId }`. Exit verifies
  `actorUid` matches and `endedAt === null` before closing the audit
  doc — a tampered cookie can't overwrite an unrelated record.
- Exit (`POST /api/admin/impersonate/exit`) clears the marker and the
  borrowed `__session` cookie via `clearSessionCookieOnly()`. It
  deliberately **does not** revoke the target's refresh tokens — the
  target may have real sessions on their own devices that must keep
  working.
- Stale-cookie guard: the layout suppresses the banner when
  `marker.actorUid === user.uid` (admin re-signed in as themselves
  without the marker being cleared) so the banner can't lie.

- High-trust writes are refused outright, and the admin tree is closed.
  Two mechanisms, covering two different kinds of write:
  - `assertNotImpersonating()` in `src/lib/firebase/impersonation.ts`
    returns a 403 with honest copy while a LIVE marker is set, and every
    mutating route handler under `src/app/api/courses/**` calls it
    first. `tests/impersonation-guard.test.mjs` lists those routes
    literally, checks each handler calls the guard at its top (in every
    export form Next accepts, not just `export async function`), and
    fails when a new mutating route appears in the tree without the
    call. The list is the place to add the admissions, membership and
    export routes as those land.
  - `(app)/admin/layout.tsx` renders a notice instead of its children
    while the marker is live. The course editors under `/admin/courses`
    write to Firestore **client-direct** (`courseMutations.ts` from
    CourseEditor, RunEditor, WeekEditor, GroupEditor), so no route
    handler exists there for the guard to sit in, and a `draftCourse`
    holder can now reach that tree. A notice rather than a redirect: a
    redirect would tell the admin the member cannot reach `/admin` at
    all, which is the wrong answer to the question view-as exists to ask.
  - NOT covered: client-direct writes from any other surface. Those
    answer to `firestore.rules`, which sees the target. A new surface
    that writes client-direct needs its page tree closed the same way,
    or its write routed.
  - A marker whose `actorUid` equals the current session's uid is stale,
    not a session (the admin is signed in as themselves again). The
    banner, the admin gate and the write guard all decide that with the
    same `markerIsLive()` helper, and the guard clears the cookie the
    way `POST /api/admin/impersonate` does.

Operational caveats (by design with full impersonation):
- Writes during a view-as session are recorded by Firestore as the
  target performing them (`createdAt`/`updatedAt`/`actorUid` fields look
  identical to a real target write). The banner copy warns; the
  `impersonations` log records the start/end window for after-the-fact
  correlation, but per-write attribution to "admin acting as X" is not
  reconstructable. That is why the guard above refuses rather than
  annotates.
- The guard and the admin gate both read an httpOnly cookie, so no page
  script can remove it, but an admin with devtools open can delete it
  from their own browser and write as the target anyway. They enforce
  intent against accidents, not against a determined admin, who in any
  case holds the rights to make those writes under their own name.
- Exit requires re-authentication: `signInWithCustomToken` on start
  replaced the admin's Firebase Auth client state with the target's,
  and Firebase Auth client SDK has no way to "restore" the previous
  session. Exit signs out of Firebase Auth and redirects to
  `/login?from=impersonation-exit`.
- A persistent yellow banner sits sticky at the top of `<main>` for the
  duration of any view-as session ("Viewing as {name} ({role}) — any
  actions you take will be recorded as this member") with an
  Exit view-as button.

Files: [src/lib/firebase/impersonation.ts](src/lib/firebase/impersonation.ts),
[src/auth/impersonation.ts](src/auth/impersonation.ts),
[src/app/api/admin/impersonate/route.ts](src/app/api/admin/impersonate/route.ts),
[src/app/api/admin/impersonate/exit/route.ts](src/app/api/admin/impersonate/exit/route.ts),
banner in [src/layout/AppShell.tsx](src/layout/AppShell.tsx),
entry button in [src/features/admin/MemberItem.tsx](src/features/admin/MemberItem.tsx).

## Task visibility model (shipped)

Every task carries one of two visibility levels:
- **`committee`**: every SU-recognised committee member and admin sees it on the
  board. Non-SU committee see it only if they are a completer or reviewer.
- **`assignees-only`**: only the listed completers, reviewers, and admins see
  it. Flipping a task to `assignees-only` is admin-only.

Worksheet tasks (`source: "worksheet"`, one per recipient, minted by the
circulation routes) are always `assignees-only`, carry no blocks or subtasks,
and are pointed at their circulation by `artefact`. Their Done is decided by
the worksheet lifecycle (docs/worksheets.md), not by the lock-in ritual.

Who sees what:
- **Member** (approved, non-committee): `/dashboard`, `/tasks` (My Work),
  `/profile`. On tasks, only those they are a completer or reviewer on. They can
  self-create `personal` + `assignees-only` tasks for themselves (the My Work
  quick-add).
- **Non-SU committee**: the above plus the Committee sidebar group, but the
  committee task board itself is gated to SU-recognised committee. They
  collaborate only on committee tasks they are explicitly added to.
- **SU-recognised committee**: the full committee task board (every
  `committee`-visibility task) and member-roster reads.
- **Admin**: everything, including flipping task visibility and the Admin tab.

The `permissions` map gates the Newsletter and Events tools independently of all
of the above.

## Field-limit + validation conventions

- `src/lib/firestore/users.ts` exports `FIELD_LIMITS` (keep client + Firestore rules in sync)
- `validateUniversityEmail()` there enforces `@nottingham.ac.uk` (subdomains allowed)
- Long textareas use `CountedTextarea` which shows live char-remaining counter

## Git workflow

`main` is **protected** — direct pushes, force pushes, and deletions are all blocked. Every change reaches `main` via a PR (even from the repo owner).

When making changes:

1. **Never commit or push directly to `main`.** Always branch first. Also never force-push a branch that others might have pulled.
2. **Branch name**: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`. Short but descriptive.
3. **Base branch and PR target**:
   - Tiny, obviously-safe changes (docs, tooling, one-line fixes) → branch off `main`, PR into `main`.
   - Anything that benefits from testing in a prod-like environment first → branch off `main`, PR into `dev`, verify on the dev App Hosting URL, then PR from `dev` into `main`.
4. **Flow per change**:
   ```sh
   git checkout -b feat/my-change   # from main
   # edit + commit
   git push -u origin feat/my-change
   # open PR on GitHub; self-merge (0 approvals required but PR is mandatory)
   # locally after merge:
   git checkout main && git pull && git branch -d feat/my-change
   ```
5. **PR titles/descriptions are employer-visible** (repo is public). Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`). Body explains the *why*, not a re-narration of the diff.
6. **The `dev` branch** auto-deploys to the `naisi-website-dev` App Hosting backend on every push — see Deploy. When a hotfix lands on `main`, merge `main` → `dev` so dev doesn't drift behind on fixes.

If asked to "commit and push" a change, default to creating a branch + PR unless the user explicitly says "push straight to main" (which will fail anyway). When in doubt, ask which base branch (main or dev).

## Testing model

Full version: [docs/testing.md](docs/testing.md). The short version:

- **Guards test two layers together.** Until September 2026 every check inspected one layer, and the bugs that reached production lived in the seams: a client query whose shape did not satisfy its rule (live on prod from 6 May to 3 September 2026, #261), a query with no declared index (the emulator does not enforce them), a client module reaching a server-only one (only the build catches it). The worked examples: `scripts/rules-tests/tests/client-queries.test.mjs` runs every client SDK read in `src` against the emulator as every persona, keyed by a registry that names each read's gate and outcome; `tests/firestore-indexes.test.mjs` extracts every query in `src` and `scripts` and fails on one that needs an index `firestore.indexes.json` does not declare (and warns on a declared index no query uses); `tests/client-server-boundary.test.mjs` walks every `"use client"` import graph for `server-only`.
- **Review detects, guards enforce.** When a review or an incident finds a new class of failure, the fix lands with a guard for the class in the same pull request. Fixing the instance without the guard is the thing not to do.
- **Guards enumerate the tree.** A test that covers only the bug you found is a regression test. A guard walks every route, query or client file, so new work is covered without anyone remembering. Every registry or allowlist is checked in both directions, carries a written reason per entry, and reports what it cannot resolve rather than skipping it.
- **Every change runs the whole battery**, locally and in CI: `npx next typegen && npx tsc --noEmit`, `npm run lint` (0 errors; the warning baseline on dev is 9, and a local checkout with skip-worktree overrides shows more: this machine shows 32), `npm test`, `cd scripts/rules-tests && npm test`, and a real `npm run build`, because Next enforces the client and server boundary only when it bundles.
- **Test as a member, never only as an admin.** Admins take a resource-independent branch of nearly every rule, so admin testing hides member-facing failures by construction.
- **End-to-end suite**: see the section of the same name in docs/testing.md.
- **A change to a covered surface updates its spec in the same pull request.** `tests/e2e-coverage-map.test.mjs` says which surfaces those are: a verified spec's `covers`, everything else written down in `NOT_COVERED` with a reason and the trigger that closes it.

## Deploy

Two separate Firebase projects, each with its own App Hosting backend. The backend IDs DIFFER: prod's is `naisi`, dev's is `naisi-website` (verified via `apphosting:backends:list` 2026-08-29 after the old "both are naisi-website" claim here caused a failed grantaccess):

- **Production** — push to `main` → project `naisi-website` → `https://naisi.uk`
- **Dev / staging** — push to `dev` → project `naisi-website-dev` → `https://dev.naisi.uk`. Separate Firestore / Auth / Storage / Secret Manager — fully isolated from prod data.

**How env vars resolve:**

- `apphosting.yaml` in this repo is the base (prod-shaped values). Both backends read it.
- The dev backend overrides the handful of values that differ via Firebase console → App Hosting → `naisi-website` (dev project) → Settings → Environment variables. Current overrides: `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `SMTP_FROM_NAME`, `NEXT_PUBLIC_APP_URL`. UI env vars override yaml.
- Secrets are resolved by *name* from each project's own Secret Manager — so `naisi-web-api-key` on the prod backend pulls the prod value, same name on the dev backend pulls the dev value. No yaml difference required.
- Don't reintroduce `apphosting.<env>.yaml` override files — that mechanism doesn't exist in current Firebase App Hosting.

**`availability` (BUILD vs RUNTIME) and what reaches the browser — two independent things, easy to conflate (learned the hard way 2026-08-01):**

- **Only `NEXT_PUBLIC_`-prefixed vars ever reach the browser**, and only because Next.js inlines them into the client JS bundle at BUILD time. A var *without* that prefix is never sent to the client, whatever its availability. So a `NEXT_PUBLIC_` var MUST be build-available (it's baked into the JS then); a server-only secret only needs RUNTIME.
- **`availability` is about the SERVER, not the browser.** `BUILD` = present during `next build` (Cloud Build); `RUNTIME` = present in the running Cloud Run container while it serves requests. `RUNTIME` does NOT mean "exposed to the browser at runtime" — it means the server process can read it while handling a request. An adversary loading the site cannot read a RUNTIME-only (non-`NEXT_PUBLIC_`) var.
- **The `availability` restriction exists ONLY in `apphosting.yaml`, NOT the console.** Env vars added in the Firebase console are ALWAYS `[BUILD, RUNTIME]` — there is no console checkbox for it (verified against Firebase docs 2026-08-01). So a `NEXT_PUBLIC_*` set in the console is automatically build-inlined; you can't accidentally scope it RUNTIME-only there. (Console values also override `apphosting.yaml` on conflict.) Console env-var changes take effect on the *next* build/rollout.
- **Worked example — reCAPTCHA (the two keys are NOT interchangeable):** `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` is the PUBLIC site key, build-inlined into the client bundle (read in `components/ui/RecaptchaInvisible.tsx`) — it is *meant* to be in the browser and gates the widget/token. `RECAPTCHA_SECRET` is the PRIVATE key, read ONLY in `lib/recaptcha/server.ts` (`import "server-only"`, called from `/api/register`), RUNTIME-only, never bundled — the server uses it to validate the browser's token via Google `siteverify`. Public key issues the token client-side; secret validates it server-side. Set the secret as a Secret Manager reference, not a plaintext value. `verifyRecaptcha` fails CLOSED in production when the secret is absent, so the secret MUST be provisioned on each backend that runs prod-mode (both prod and dev — dev builds in prod mode).

**CLI cheatsheet:**

- **Firestore rules/indexes**: `npx firebase deploy --only firestore:rules,firestore:indexes --project <default|dev>`
- **App Hosting secrets**: `firebase apphosting:secrets:set <NAME> --project <default|dev>` creates the secret; `firebase apphosting:secrets:grantaccess <NAME> --backend <naisi|naisi-website> --project <default|dev>` grants the backend access once it exists (`naisi` on prod, `naisi-website` on dev).
- **Trigger a rollout from current branch tip**: `firebase apphosting:rollouts:create <naisi|naisi-website> --project <default|dev> --git-branch <branch>` (or just push a commit — deploys happen on push).
- **Local dev**: `npm run dev`, needs `.env.local` with `NEXT_PUBLIC_FIREBASE_*` + `FIREBASE_ADMIN_*` + `EVENTS_TOKEN_SECRET` values (see `.env.example`). Point at prod or dev project depending on what you're debugging.

**Dev-env discipline**: dev uses the same email sender as prod (display name tagged `NAISI (dev)`). Any user doc in dev Firestore can receive real mail on the next test send. Only seed dev with email addresses you personally own.

**Typical workflow**: feature branch off `main` → PR into `dev` → merge → auto-deploy to dev → click around the real build → PR from `dev` into `main` → merge → auto-deploy to prod. Tiny / docs-only changes can PR directly into `main`. When a hotfix lands on `main`, merge `main` → `dev` so dev doesn't drift behind on fixes.

## What's shipped

- **Public site**: editorial landing page (engagement tiers, curated reading lists, subscribe form), Members directory, Resources, News list + article (SSR + OG tags), public Events list + event detail page with the full RSVP flow (submit, confirmation, change request, self-cancel).
- **Auth**: `/login`, `/register` (full profile form, university-email magic-link verification, duplicate-uni-email block), `/pending-approval`.
- **Member area**: Dashboard with a My Work summary, `/tasks` (personal + assigned tasks, quick-add), `/profile` (profile edit + per-category notification preferences).
- **Task manager** (`/committee/tasks` + `/tasks`): kanban board, subtasks grouped into ordered blocks with sequential gating, per-block reviewer signoff (lock-in ritual + review matrix), task templates, calendar view, activity feed, threaded comments with @mentions, attachments, My Work, email notifications. Visibility is `committee` vs `assignees-only`; the committee board is gated to SU-recognised committee.
- **Newsletter**: block-based editor (rich text, images with crop), per-user draft/approve permissions, draft → pending → approved → sent pipeline, server-side send, test send.
- **Events**: modular signup-form builder, RSVP system (pending / confirmed / waitlisted / denied / cancelled), capacity + waitlist, approve / deny / change-request flow, ICS export + calendar email links, cover-image crop + emblem branding overlay, food declaration + dietary tags, pizza order helper, post-publish editing with opt-in change-notification emails (date, time, location, or description), event cancellation with an optional attendee notice, event archiving, admin test-RSVP generation. The events area is open to the whole committee; `draftEvent` gates creating an event and `approveEvent` gates publishing it; an author or admin can add committee members to a single event's `collaboratorUids` so they can edit just that event. Attendee PII (the RSVP list, CSV export, broadcast send) is restricted to SU-recognised committee and admins.
- **Subscriptions**: junction-collection architecture (one row per email + channel, orthogonal `confirmed` / `subscribed` axes), append-only event log, admin Subscriptions tab (spreadsheet-style table, guest delete, history cap).
- **Admin dashboard tabs**: Approvals, Members (role / title / bio / `suRecognised` / `permissions` / `tracks` edit + full profile edit + hard delete + "View as" debug impersonation), Projects (CRUD + archive), Newsletter, Subscriptions, Email designs (application email templates), Deliverability (send log + suppression list), Task templates, Danger zone.
- **Admin "view as" debug tool**: per-member "View as" button on the admin Members page does a full impersonation (Firebase custom token → target session cookie) so the admin sees exactly what the member sees, with a sticky banner and audit log (`impersonations` collection). See Roles and access → Admin "view as" for trust properties and operational caveats.
- **Email infrastructure**: Resend send pipeline, deliverability dashboard, bounce/complaint webhook, application lifecycle emails, transactional emails as JSX templates in `src/emails/`.
- **Users-collection lockdown**: member PII is readable only by SU-recognised committee + admins (and each user's own doc); `suRecognised` enforced as a trust boundary in Firestore rules.
- **Brand**: real NAISI emblem integrated across the site, favicon, and email logo.
- **Worksheets** (`/worksheets`, `/worksheets/respond/[circulationId]`): a library with folders of question documents (short and long text, single and multiple choice, polls, rating scales, image-upload answers, rich bodies with images and YouTube or Loom embeds, section headings, page breaks), circulated to committee members as one `assignees-only` task each with the sender as reviewer; a circulation page with per-recipient progress, state and coarse activity (first open, page opens, active time); a mobile-first respond page with autosave and a Save button; review with per-question feedback and reviewer-only scores, returned feedback, admin unfreeze; aggregate views, logged CSV export, per-circulation notification toggles, and a due-soon reminder job that ships dark. Contract and decisions: [docs/worksheets.md](docs/worksheets.md).
- **Courses**: the full BlueDot-style programme surface (catalogue, applications, allocation, member `/learn` area, facilitator tooling, weekly nudge emails). Landed as the P/V2 course series through 2026-08.
- **Installable app (PWA)**: manifest + icons, write-nothing service worker with offline fallback, back-gesture overlay dismissal, standalone safe-area chrome, stale-session repair, Google sign-in via redirect inside installed apps (popup elsewhere), install affordances, relaunch restore, and web push with task-email mirroring (dormant until VAPID secrets are provisioned per environment). Reference: [docs/pwa.md](docs/pwa.md).

## What's not built yet

1. **Credentials store** — committee-only encrypted credentials (social accounts, API keys). Plan: client-side AES-GCM with a PBKDF2-derived key from a shared master password. The `credentials` / `credentialsMeta` Firestore rules are deployed and the `/credentials` route exists as a placeholder, but there is no feature code.
2. **1-1 booking calendar + meeting calendar** — `bookings` has a read rule only; all client writes are locked, and there is no UI or server route. The intended model: per-committee-member availability → bookings, group meetings created by track leads / committee (visible to committee as greyed-out slots unless they're on the invite), private admin meetings hidden from committee, ICS export, and a Firestore transaction for conflict prevention.
3. ~~Course/homework viewer~~ BUILT (the V2 course series, 2026-08): public `/courses` catalogue + application flow, member-facing `/learn` with per-run weeks, exercises, attendance and progress, admin course/run/group management, per-group curricula and pacing, templates, the retrospective loop, and the archive/destroy protocol. See `src/features/courses/` and the `courses/*` API tree.
4. **Track-lead sub-role** — admins designating a member or committee member as head of a specific reading group / fellowship track / project, orthogonal to the governance role. No data field, UI, or rules exist. (The existing `users.tracks` field is unrelated: it is an admin `technical` / `governance` tag, not a leadership role.)
5. **Cohort channels** — the subscriptions junction collection already accepts `cohort:<id>`-style channel strings as data, but no cohort feature creates or sends to them yet.

## Local dev: auth bypass

`src/lib/devBypass/` is an optional shim that lets you run authed surfaces (dashboard, tasks, admin) on localhost without a real Firebase Auth session. Useful for UI work + mobile pass iteration where signing in repeatedly is friction.

**Architecture:**

- `types.ts` (committed): the `BypassAPI` interface. One method per bypassed surface (auth user/snapshot/server-user; users/projects/tasks lists; single task by ID).
- `local.ts` (committed **stub**): every method returns `null`, `isActive: false`. Production builds use this as-is, so any bypass branch in production code is a no-op. An accidental `NEXT_PUBLIC_DEV_BYPASS_AUTH=true` on a deployed backend **cannot** activate the bypass: the activation logic isn't here.
- `index.ts` (committed): re-exports `bypass` from `./local`.
- `fixtures.ts` (**not committed**, local-only via `.git/info/exclude`): the real fixture data (users, projects, tasks). Stays off GitHub because it carries real emails / names.
- Production files (`AuthProvider.tsx`, `proxy.ts`, `session.ts`, the 7 data hooks) import `bypass` and have small dormant branches like `const fixture = bypass.getUsers(); if (fixture !== null) { ... }`. With the stub, these branches don't fire.

**Defer-to-real-session:** bypass cedes to any real Firebase Auth session. `getCurrentUser`, the proxy, and `AuthProvider` all check for a real cookie / signed-in user first and only fall back to the bypass when there isn't one. So you can `/login` normally on localhost and test real-auth surfaces (events editor, etc.) without flipping the env var.

**Activating locally (one-time setup, per machine):**

```sh
# 1. Construct a local fixtures.ts (paste your fixture data). The file is
#    already in .git/info/exclude so it never lands on GitHub.

# 2. Replace the committed stub `local.ts` with a real impl that reads
#    NEXT_PUBLIC_DEV_BYPASS_AUTH and returns the fixtures. Reference impl:
#
#    import type { BypassAPI } from "./types";
#    import { DEV_USERS, DEV_PROJECTS, DEV_TASKS } from "./fixtures";
#    const ACTIVE = process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "true";
#    const DEV_USER = { uid: "dev-bypass-admin", … } as unknown as User;
#    const SESSION = { uid: "dev-bypass-admin", role: "admin", … };
#    const SNAPSHOT = { role: "admin", permissions: { … }, suRecognised: true };
#    export const bypass: BypassAPI = {
#      isActive: ACTIVE,
#      getAuthUser: () => ACTIVE ? DEV_USER : null,
#      getAuthSnapshot: () => ACTIVE ? SNAPSHOT : null,
#      getServerUser: () => ACTIVE ? SESSION : null,
#      getUsers: () => ACTIVE ? DEV_USERS : null,
#      getProjects: () => ACTIVE ? DEV_PROJECTS : null,
#      getTasks: (q) => ACTIVE ? applyFilters(DEV_TASKS, q) : null,
#      getTask: (id) => ACTIVE ? (DEV_TASKS.find(t => t.id === id) ?? null) : null,
#    };

# 3. Hide your local override from git so it never lands on GitHub.
git update-index --skip-worktree src/lib/devBypass/local.ts

# 4. Enable in .env.local
echo "NEXT_PUBLIC_DEV_BYPASS_AUTH=true" >> .env.local

# 5. Restart the dev server. Bypass is now live.
```

**Disabling without removing files:** set `NEXT_PUBLIC_DEV_BYPASS_AUTH=false` (or sign in for real, since the bypass cedes automatically). To revert the override entirely: `git update-index --no-skip-worktree src/lib/devBypass/local.ts && git checkout -- src/lib/devBypass/local.ts`.

**Why one file with skip-worktree, not 11:** an earlier version of this shim hand-modded 10 production files (`AuthProvider`, hooks, proxy, session) with `--skip-worktree` flags. That mechanism made cross-branch checkouts brittle (any branch with a real edit to a flagged file errored on switch) and risked leaking the bypass if you ever resaved a flagged file without the dance. The current design keeps committed production code clean. The only file you `--skip-worktree` is `local.ts`, and only when the BypassAPI interface itself changes (rare) do you have to re-run the dance.

## Debug instrumentation

Two console-tagged probes exist for live debugging, both gated so they only emit when explicitly turned on:

- **`[monitor]` — auth + nav lifecycle** ([src/lib/devMonitor.ts](src/lib/devMonitor.ts)). Logs the sign-in handoff (popup → idToken → `/api/auth/session` → router push), AuthProvider lifecycle (`onAuthStateChanged`, the user-doc snapshot's first fire / metadata), and AppShell mounts + pathname + loading transitions. Includes watchdogs that warn when expected events don't fire — most usefully the "still on /login 6s after a successful signin" alarm. Built to chase the intermittent "sign-in completes but stays on /login" symptom and similar nav hangs. **Enable** by setting `NEXT_PUBLIC_DEBUG_MONITOR=true` on the dev backend's UI env vars in the Firebase console (UI env vars override `apphosting.yaml` per Deploy). Don't set it on prod — even though it's just console noise, it's employer-visible. Filter the devtools console on `[monitor` to read just these lines.
- **`[rt-debug]` — events realtime listeners** (parked on branch `fix/events-realtime-listener`, commits 522a7cb + 116733f, **unmerged**). Logs attach/detach, per-instance ids, snapshot metadata, timing, and a 10s no-first-snapshot watchdog on `useEventRsvps`, the EventEditor event-doc listener, and `useEvents`. Built for the events listener staleness investigation; can be revived if that bug resurfaces. Different tag from `[monitor]` so the two can coexist.

## Installable app (PWA)

The site installs to the home screen on iOS/Android while remaining a normal website. **[docs/pwa.md](docs/pwa.md) is the reference**: the service worker's write-nothing contract and rollback runbook, standalone detection (attributes for layout, hook for behaviour), the auth story inside installed apps, the deliberately-not-done list, and the device checklist. The worker's contract is enforced by `tests/pwa-offline-assets.test.mjs`, so broadening `public/sw.js` fails `npm test` by design. `public/offline.html` is generated: edit `scripts/offline-template.html` and run `npm run brand`.

## Mobile

The site was built desktop-first and is in the middle of a deliberate mobile-friendliness pass (tracked on `feat/mobile-friendly`). Three documents capture the conventions:

- [docs/mobile-conventions.md](docs/mobile-conventions.md) — the desktop-first + mobile-adapt-block pattern, the canonical breakpoint set, the no-CSS-vars-in-@media gotcha.
- [docs/mobile-baseline-events.md](docs/mobile-baseline-events.md) — the events RSVP flow is mobile-frozen. Any PR touching the listed modules or the tokens they consume must re-verify the baseline before merging.
- [docs/touch-targets.md](docs/touch-targets.md) — the 44×44 enforced-vs-aspirational split.

Going-forward rule: features ship desktop-first on their own branch into `dev`. Mobile adaptations land in a separate follow-up PR per feature so the two concerns don't muddle. New CSS modules end with an `@media (max-width: …)` block — even if empty with a `/* TODO: mobile pass */` placeholder — so the question is asked at design time.

Canonical breakpoints: `36rem` (sm), `48rem` (md), `60rem` (lg), `80rem` (xl). Defined in [src/theme/breakpoints.ts](src/theme/breakpoints.ts), mirrored as a comment block at the top of [src/theme/tokens.css](src/theme/tokens.css).

## Known gotchas

- Firestore composite indexes on users took ~2-10 min to build; queries fail until they finish
- Hot reload sometimes leaves CSS Module hashes stale — restart `npm run dev` if styling looks broken
- Service account key rotation: remember to delete the old key in Google Cloud IAM after generating a new one
- **`createCustomToken` needs an IAM role grant on App Hosting.** The Admin SDK signs custom tokens by calling IAM's `signBlob` API; the runtime service account (`firebase-app-hosting-compute@<project>.iam.gserviceaccount.com`) needs `roles/iam.serviceAccountTokenCreator` granted *on itself*. Without it, `auth.createCustomToken()` throws `Permission 'iam.serviceAccounts.signBlob' denied`. Granted on dev + prod for the view-as feature; needs to be granted again for any future feature that mints custom tokens on a new backend. One-liner: `gcloud iam service-accounts add-iam-policy-binding <SA_EMAIL> --member="serviceAccount:<SA_EMAIL>" --role="roles/iam.serviceAccountTokenCreator" --project=<PROJECT_ID>`.
