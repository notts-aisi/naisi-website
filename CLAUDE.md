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
│   │   ├── credentials/                     # placeholder page — feature not built
│   │   ├── newsletter/  events/manage/      # drafter / approver tools
│   │   └── admin/                           # Approvals, Members, Projects, Newsletter,
│   │                                        #   Subscriptions, Email designs, Deliverability,
│   │                                        #   Task templates, Danger zone
│   ├── verify-email/[tokenId]/       # uni-email magic-link landing
│   └── api/                          # session, admin/*, events/*, tasks/*, newsletter/*,
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
- **Main-area width — lessons from a reverted attempt (PR #11, reverted 2026-04-21)**: `AppShell`'s `<main>` caps at `max-width: 64rem` (1024px). A per-route opt-in for a wider 100rem cap was tried so kanban pages could fill fullscreen — scrapped because:
  1. **Authed pages must not overflow horizontally.** `TaskBoard`'s fixed-width columns overflow at intermediate viewports, and `AppShell`'s sidebar is only `position: sticky` vertically (not horizontally) — so horizontal document scroll orphans the nav and the user has to scroll past empty space to reach it. Worse UX than the narrow cap it was trying to fix.
  2. **Fix the page, not the shell.** Wide-data views (kanban, courses grid, booking calendar, wide tables) must handle their own responsiveness — internal horizontal scroll *inside their own container*, collapsing columns, or stackable layouts — before the shell's cap is ever revisited. If a future wide-cap attempt is made, the sidebar likely needs to become viewport-fixed (not just sticky) so horizontal scroll can't orphan it.

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
                        "personal"), kind, priority, dueDate, …
  tasks/{id}/comments     threaded comments with @mentions
  tasks/{id}/activity     append-only activity log
  tasks/{id}/attachments  attachment metadata (files in Storage)

taskTemplates/{id}      { name, description, kind, subtasks[],
                          defaultCompleterCount, createdByUid, … }

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
role: `draftNewsletter`, `approveNewsletter`, `draftEvent`, `approveEvent`.
Admins implicitly hold all four. These gate the Newsletter and Events drafter
tools and the matching Firestore rules, so a plain `member` can be granted
`draftEvent` without being promoted to committee.

### `tracks` (admin tags, shipped)

`users/{uid}.tracks` is an admin-set array of `"technical" | "governance"` tags
noting which side(s) of the course programme a user aligns with. Private
(admin-only in rules), not a permission and not a leadership role.

## Task visibility model (shipped)

Every task carries one of two visibility levels:
- **`committee`**: every SU-recognised committee member and admin sees it on the
  board. Non-SU committee see it only if they are a completer or reviewer.
- **`assignees-only`**: only the listed completers, reviewers, and admins see
  it. Flipping a task to `assignees-only` is admin-only.

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

## Deploy

Two separate Firebase projects, each with its own App Hosting backend (both backends happen to be named `naisi-website` — not a bug, disambiguated by project):

- **Production** — push to `main` → project `naisi-website` → `https://naisi.uk`
- **Dev / staging** — push to `dev` → project `naisi-website-dev` → `https://dev.naisi.uk`. Separate Firestore / Auth / Storage / Secret Manager — fully isolated from prod data.

**How env vars resolve:**

- `apphosting.yaml` in this repo is the base (prod-shaped values). Both backends read it.
- The dev backend overrides the handful of values that differ via Firebase console → App Hosting → `naisi-website` (dev project) → Settings → Environment variables. Current overrides: `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `SMTP_FROM_NAME`, `NEXT_PUBLIC_APP_URL`. UI env vars override yaml.
- Secrets are resolved by *name* from each project's own Secret Manager — so `naisi-web-api-key` on the prod backend pulls the prod value, same name on the dev backend pulls the dev value. No yaml difference required.
- Don't reintroduce `apphosting.<env>.yaml` override files — that mechanism doesn't exist in current Firebase App Hosting.

**CLI cheatsheet:**

- **Firestore rules/indexes**: `npx firebase deploy --only firestore:rules,firestore:indexes --project <default|dev>`
- **App Hosting secrets**: `firebase apphosting:secrets:set <NAME> --project <default|dev>` creates the secret; `firebase apphosting:secrets:grantaccess <NAME> --backend naisi-website --project <default|dev>` grants the backend access once it exists.
- **Trigger a rollout from current branch tip**: `firebase apphosting:rollouts:create naisi-website --project <default|dev> --git-branch <branch>` (or just push a commit — deploys happen on push).
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
- **Admin dashboard tabs**: Approvals, Members (role / title / bio / `suRecognised` / `permissions` / `tracks` edit + full profile edit + hard delete), Projects (CRUD + archive), Newsletter, Subscriptions, Email designs (application email templates), Deliverability (send log + suppression list), Task templates, Danger zone.
- **Email infrastructure**: Resend send pipeline, deliverability dashboard, bounce/complaint webhook, application lifecycle emails, transactional emails as JSX templates in `src/emails/`.
- **Users-collection lockdown**: member PII is readable only by SU-recognised committee + admins (and each user's own doc); `suRecognised` enforced as a trust boundary in Firestore rules.
- **Brand**: real NAISI emblem integrated across the site, favicon, and email logo.

## What's not built yet

1. **Credentials store** — committee-only encrypted credentials (social accounts, API keys). Plan: client-side AES-GCM with a PBKDF2-derived key from a shared master password. The `credentials` / `credentialsMeta` Firestore rules are deployed and the `/credentials` route exists as a placeholder, but there is no feature code.
2. **1-1 booking calendar + meeting calendar** — `bookings` has a read rule only; all client writes are locked, and there is no UI or server route. The intended model: per-committee-member availability → bookings, group meetings created by track leads / committee (visible to committee as greyed-out slots unless they're on the invite), private admin meetings hidden from committee, ICS export, and a Firestore transaction for conflict prevention.
3. **Course/homework viewer** (BlueDot-style) — a member-facing view of the courses/homework someone is enrolled in. Nothing built.
4. **Track-lead sub-role** — admins designating a member or committee member as head of a specific reading group / fellowship track / project, orthogonal to the governance role. No data field, UI, or rules exist. (The existing `users.tracks` field is unrelated: it is an admin `technical` / `governance` tag, not a leadership role.)
5. **Cohort channels** — the subscriptions junction collection already accepts `cohort:<id>`-style channel strings as data, but no cohort feature creates or sends to them yet.

## Known gotchas

- Firestore composite indexes on users took ~2-10 min to build; queries fail until they finish
- Hot reload sometimes leaves CSS Module hashes stale — restart `npm run dev` if styling looks broken
- Service account key rotation: remember to delete the old key in Google Cloud IAM after generating a new one
