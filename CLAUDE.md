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
- Firebase App Hosting, not classic Firebase Hosting — see `apphosting.yaml`.

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
- **Brand mark**: `src/components/BrandMark.tsx` is a placeholder SVG. When real castle+shield asset lands, swap just that file + `public/favicon.svg`.
- **Client vs server components**: public pages lean server-side (SSR + `generateMetadata` for OG tags). Authed pages are client components so real-time Firestore `onSnapshot` works. `(app)/layout.tsx` is a Server Component that role-gates with `getCurrentUser()`.
- **Two-layer auth gate**: `src/proxy.ts` does a fast session-cookie presence check on protected routes. Real role enforcement happens in `(app)/layout.tsx` via `getCurrentUser()` (Admin SDK, reliable).
- **No `orderBy` on sparse fields**: Firestore drops docs missing the ordered field. Query without orderBy, sort client-side, or only orderBy on fields that are *always* present.
- **No `undefined` in `setDoc`**: Firestore refuses it. Use the `compact()` helper in `src/auth/signInWithGoogle.ts` before writing.

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
vault/{id}         (not yet built — will be client-side AES-GCM encrypted)
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

## Deploy

- **Site**: push to `main` → Firebase App Hosting GitHub integration rebuilds + deploys
- **Firestore rules/indexes**: `npx firebase deploy --only firestore:rules,firestore:indexes`
- **Local dev**: `npm run dev`, needs `.env.local` with `NEXT_PUBLIC_FIREBASE_*` + `FIREBASE_ADMIN_*` values (see `.env.example`)

## What's shipped (v1)

- Public: Landing, Members, Resources, News list + article (SSR + OG tags)
- Auth: `/login`, `/register` (full profile form with status/subject/graduation/interests/newsletter), `/pending-approval`
- Admin dashboard: Approvals queue, Members tab (role/title/bio/showOnMembers edit + full profile edit + delete), Projects tab (CRUD + archive + delete)
- Hard-delete user flow (Firestore doc + Auth account) via server route

## What's not built yet

1. **Committee task manager** — lives on a **Committee-only tab** (hide from `member` role in sidebar). Scoped to projects/reading groups, progress bars, real-time. Track leads can manage tasks for their track; committee members see all committee tasks; admins see everything.
2. **Password vault** — committee-only; client-side AES-GCM with PBKDF2-derived key from a shared master password
3. **1-1 booking calendar + meeting calendar** — implement the tiered visibility model:
   - Per-committee-member availability → bookings (already sketched out)
   - Group meetings created by track leads / committee (visible to committee greyed-out unless they're on the invite)
   - Private admin meetings (hidden from committee by default)
   - ICS export; Firestore transaction for conflict prevention
4. **Track-lead sub-role** — data model (`users/{uid}.trackLeadOf: string[]`), admin UI on the Projects tab to assign/unassign, enforcement in Firestore rules so track leads can manage their track's tasks/meetings
5. **Course/homework viewer** (BlueDot-style) — only what a member is enrolled in shows on their dashboard
6. **Newsletter sending pipeline** — the register form already collects prefs; no send infra yet — Trigger Email extension is the plan

### Sidebar implication when task manager ships

Current `src/layout/AppShell.tsx` has `Tasks` visible to `[member, committee, admin]`. When the committee task manager ships, change that entry to `[committee, admin]` only, and rename the sidebar label to **"Committee"** (or group tasks, vault, calendar-host views under one "Committee" section). A member-facing "My work" area — showing their enrolled courses, homework, and upcoming sessions — is a separate concept.

## Known gotchas

- Firestore composite indexes on users took ~2-10 min to build; queries fail until they finish
- Hot reload sometimes leaves CSS Module hashes stale — restart `npm run dev` if styling looks broken
- Service account key rotation: remember to delete the old key in Google Cloud IAM after generating a new one
