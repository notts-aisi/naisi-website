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
│   ├── (auth)/                       # login/register/pending-approval (minimal layout)
│   ├── (app)/                        # Authed area, server-side role-gated in its layout.tsx
│   │   ├── dashboard/  admin/ (+members, +projects subpages)
│   └── api/
│       ├── auth/session/             # mint/clear session cookie from Firebase ID token
│       └── admin/users/[uid]/        # admin DELETE: wipes Firestore doc + Firebase Auth account
├── auth/                             # AuthProvider, signInWithGoogle, completeRegistration
├── components/ui/                    # Button, Card, Badge, Input, StatusSelect, GraduationSelect, CountedTextarea
├── features/
│   ├── admin/                        # useApprovals, useMembers, useProjects, usePendingCount, adminMutations
│   ├── members/  news/               # server-side fetchers for public pages
├── layout/                           # PublicHeader, PublicFooter, AppShell
├── lib/
│   ├── firebase/                     # client.ts, admin.ts, session.ts
│   └── firestore/                    # typed helpers (users.ts, projects.ts)
├── theme/                            # tokens.css, typography.css
└── content/                          # static JSON (socials, resources)
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

```
users/{uid}        { email, displayName, photoURL, role, profile, showOnMembers,
                     title?, bio?, approvedAt?, approvedBy?, rejectedAt?, rejectedBy?,
                     createdAt }
  .profile         { preferredName, universityEmail, status, statusOther?, subject,
                     expectedGraduation?, motivation, interests?, newsletter }
  .newsletter      { subscribed, deliverToGmail, deliverToUniEmail }
projects/{id}      { name, leadUid, memberUids[], archived, createdAt, updatedAt }
tasks/{id}         (not yet built)
credentials/{id}   (not yet built — will be client-side AES-GCM encrypted; was "vault")
bookings/{id}      (not yet built — 1-1 booking calendar)
news/{slug}        { title, tldr, bodyMarkdown, publishedAt, authorName, coverImageUrl? }
```

## Roles

Governance role (mutually exclusive): `pending | member | committee | admin | rejected`. Role-change rules:
- New users always start at `pending` (enforced in Firestore rules on create)
- Self-update must keep role unchanged (rule enforces)
- Only admins can change roles — can promote member→committee→admin and demote the other way
- First admin is seeded manually via Firestore console (documented in README)

**Track-lead sub-role (planned, orthogonal to governance role):** admins can also designate a member OR committee member as **head of a specific reading group / fellowship track / project**. Being a track lead does NOT require committee status — a regular member can lead a track. This will live on `users/{uid}.trackLeadOf: [projectId, ...]` (or similar) and be managed from the admin dashboard alongside role promotion.

## Visibility tiers (what each role sees)

This shapes the task manager + calendar + future features. Keep this mental model when building:

- **Member** (approved, not committee): sees *only* their own data — their tasks/bookings in their calendar, their enrolled courses, etc. No visibility into committee work.
- **Committee** (promoted by admin): member visibility **plus** the Committee tab with:
  - Committee-only task manager (a separate board from any member-facing tasks)
  - Calendar shows their own bookings *plus* other committee/group meetings as **greyed-out** slots (can see *that* something is happening, not the details, unless they're on the invite)
- **Admin**: committee visibility **plus**:
  - Approvals, full role/project management (already built)
  - Can schedule **private admin meetings** that are *invisible to committee by default* (don't even appear greyed-out)
- **Track leads** (sub-role, orthogonal): gain ownership of a specific project/reading group/fellowship track — can schedule that group's meetings, manage its roster, etc. The track's activities are visible to committee; the track lead interacts with them from either their Committee tab (if they're committee) or a dedicated "My tracks" area (if they're just a member).

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
- **Dev / staging** — push to `dev` → project `naisi-website-dev` → `https://naisi-website--naisi-website-dev.europe-west4.hosted.app`. Separate Firestore / Auth / Storage / Secret Manager — fully isolated from prod data.

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

**Dev-env discipline**: dev uses the same Gmail SMTP as prod (same sender, display name tagged `NAISI (dev)`). Any user doc in dev Firestore can receive real mail on the next test send. Only seed dev with email addresses you personally own.

**Typical workflow**: feature branch off `main` → PR into `dev` → merge → auto-deploy to dev → click around the real build → PR from `dev` into `main` → merge → auto-deploy to prod. Tiny / docs-only changes can PR directly into `main`. When a hotfix lands on `main`, merge `main` → `dev` so dev doesn't drift behind on fixes.

## What's shipped (v1)

- Public: Landing, Members, Resources, News list + article (SSR + OG tags)
- Auth: `/login`, `/register` (full profile form with status/subject/graduation/interests/newsletter), `/pending-approval`
- Admin dashboard: Approvals queue, Members tab (role/title/bio/showOnMembers edit + full profile edit + delete), Projects tab (CRUD + archive + delete)
- Hard-delete user flow (Firestore doc + Auth account) via server route

## What's not built yet

1. **Committee task manager** — lives on a **Committee-only tab** (hide from `member` role in sidebar). Scoped to projects/reading groups, progress bars, real-time. Track leads can manage tasks for their track; committee members see all committee tasks; admins see everything.
2. **Credentials store** (was "vault") — committee-only; client-side AES-GCM with PBKDF2-derived key from a shared master password
3. **1-1 booking calendar + meeting calendar** — implement the tiered visibility model:
   - Per-committee-member availability → bookings (already sketched out)
   - Group meetings created by track leads / committee (visible to committee greyed-out unless they're on the invite)
   - Private admin meetings (hidden from committee by default)
   - ICS export; Firestore transaction for conflict prevention
4. **Track-lead sub-role** — data model (`users/{uid}.trackLeadOf: string[]`), admin UI on the Projects tab to assign/unassign, enforcement in Firestore rules so track leads can manage their track's tasks/meetings
5. **Course/homework viewer** (BlueDot-style) — only what a member is enrolled in shows on their dashboard
6. **Newsletter sending pipeline** — the register form already collects prefs; no send infra yet — Trigger Email extension is the plan

### Sidebar implication when task manager ships

Current `src/layout/AppShell.tsx` has `Tasks` visible to `[member, committee, admin]`. When the committee task manager ships, change that entry to `[committee, admin]` only, and rename the sidebar label to **"Committee"** (or group tasks, credentials, calendar-host views under one "Committee" section). A member-facing "My work" area — showing their enrolled courses, homework, and upcoming sessions — is a separate concept.

## Known gotchas

- Firestore composite indexes on users took ~2-10 min to build; queries fail until they finish
- Hot reload sometimes leaves CSS Module hashes stale — restart `npm run dev` if styling looks broken
- Service account key rotation: remember to delete the old key in Google Cloud IAM after generating a new one
