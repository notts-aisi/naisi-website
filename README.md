# NAISI — Nottingham AI Safety Initiative

The NAISI website. Public marketing site + authed committee tooling (task manager, newsletter, events + RSVPs, subscriptions, admin approvals).

## Stack

- **Next.js 16** (App Router, TypeScript)
- **React 19**
- **Firebase** — Auth (Google Sign-In), Firestore, App Hosting
- **No UI framework** — CSS modules + theme tokens in `src/theme/tokens.css` so re-theming is a one-file swap

## What's built

- Public: landing page, Members, Resources, News, Events + public RSVP flow
- Auth: `/login`, `/register` (Google + profile form + uni-email verification), `/pending-approval`
- Member area: dashboard, My Work tasks, profile + notification preferences
- Committee tooling: task manager, newsletter editor, event management
- Admin: approvals, members, projects, subscriptions, email designs, deliverability
- Email: transactional + newsletter sending via Resend

See [CLAUDE.md](./CLAUDE.md) for the full feature map and Firestore data model.

## Getting started (local dev)

### 1. Create a Firebase project

1. Create a project in the [Firebase console](https://console.firebase.google.com/). Suggested name: `naisi-website`.
2. Enable **Authentication → Google** sign-in.
3. Enable **Firestore** (start in production mode; rules are deployed below).
4. Project settings → General → Your apps → register a Web app. Copy the `firebaseConfig` values.
5. Project settings → Service accounts → Generate new private key. Save the JSON (one-time download).

### 2. Fill in env vars

```sh
cp .env.example .env.local
```

Populate the `NEXT_PUBLIC_FIREBASE_*` values from step 1.4. Populate the `FIREBASE_ADMIN_*` values from the service account JSON (the private key needs `\n` escaped — paste with newlines replaced by literal `\n`).

### 3. Install + run

```sh
npm install
npm run dev
```

Open http://localhost:3000.

### 4. Seed the first admin

The first admin has no existing admin to promote them, so set the role manually in Firestore:

1. Sign in once via `/register` and complete the profile form — this creates `users/{yourUid}` with `role: "pending"`.
2. In the Firebase console, open Firestore → `users/{yourUid}` → change `role` to `"admin"`.
3. Next sign-in lands you in the dashboard.

## Deploy Firestore rules

```sh
npx firebase login
npx firebase use naisi-website
npx firebase deploy --only firestore:rules,firestore:indexes
```

## Deploy the site (Firebase App Hosting)

1. Push the repo to GitHub.
2. Firebase console → App Hosting → "Get started" → connect the GitHub repo, live branch `main`.
3. Store the public Firebase config as secrets named in [`apphosting.yaml`](./apphosting.yaml) (or convert them to plain `value:` entries if you're fine with them in the config file).
4. App Hosting builds and deploys on every push to `main`.

Admin SDK credentials are provided automatically via Application Default Credentials in App Hosting — no `FIREBASE_ADMIN_*` vars needed in production.

## Dev / staging environment

Separate from prod so test data, test emails, and test sign-ins never touch real members.

- **Firebase project**: `naisi-website-dev` (Blaze plan) — its own Firestore, Auth, Storage, Secret Manager.
- **App Hosting backend**: `naisi-website` (same name as prod's backend, different project). URL: `https://naisi-website--naisi-website-dev.europe-west4.hosted.app`.
- **Branch**: push to `dev` → auto-deploys.
- **Env vars**: base values come from [`apphosting.yaml`](./apphosting.yaml) (prod-shaped). The dev backend overrides the values that differ via the Firebase console → App Hosting → `naisi-website` backend → Settings → Environment variables. Current overrides: `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `SMTP_FROM_NAME`, `NEXT_PUBLIC_APP_URL`. Secrets resolve by name against the dev project's Secret Manager.
- **SMTP**: same `ai-safety@uonsu.com` sender as prod, display name overridden to `NAISI (dev)` so recipients can tell real mail from test.
- **Only ever seed dev with email addresses you personally own** — any user doc in dev Firestore can get real mail on the next newsletter/RSVP test send.

One-time setup (done 2026-04-21): create the Firebase project; enable Firestore, Auth (Google), Storage; `firebase deploy --only firestore:rules,firestore:indexes,storage --project dev`; `firebase apphosting:secrets:set …` for each secret; create an App Hosting backend in the console with live branch `dev` and the 5 UI env var overrides; `firebase apphosting:secrets:grantaccess … --backend naisi-website --project dev` for each secret; trigger rollout.

## Project layout

The key folders:

- `src/app/` — App Router routes. Route groups:
  - `(public)/` — marketing site (uses `PublicHeader` + `PublicFooter`)
  - `(auth)/` — login/register/pending-approval
  - `(app)/` — authed area, server-side role-gated in its `layout.tsx`
  - `api/auth/session/` — session cookie mint/clear
- `src/theme/tokens.css` — **one file** to swap the entire colour palette
- `src/components/BrandMark.tsx` — renders the real NAISI emblem (castle + shield + head)
- `src/lib/firebase/` — `client.ts` (browser), `admin.ts` (server), `session.ts` (cookie + `getCurrentUser()`)
- `src/lib/firestore/` — typed per-collection read/write helpers
- `src/auth/` — `AuthProvider`, `signInWithGoogle`, `completeRegistration`
- `src/features/` — feature-scoped data + hooks (admin, events, members, news, newsletter, profile, tasks)
- `src/proxy.ts` — Next 16's middleware (renamed). Fast session-cookie presence check; the real role gate is in `(app)/layout.tsx`

## Theming

Edit `src/theme/tokens.css`. Every component reads `var(--color-*)` so changes propagate everywhere.

Light theme: change `data-theme="dark"` to `"light"` in [src/app/layout.tsx](src/app/layout.tsx).

## Not built yet

- Credentials store (committee-only, client-side AES-GCM with a PBKDF2-derived key)
- 1-1 booking calendar (Firestore availability + transactions)
- Course & homework viewer (BlueDot-style)
- Track-lead sub-role (admin-assigned heads of a reading group / project)

## Upcoming housekeeping

- **2026-05-06 — legacy-URL cleanup** (two weeks after the Safari auth fix / custom-domain migration landed 2026-04-22). By this date, confirm the new domains (`naisi.uk` + `auth.naisi.uk` on prod, `dev.naisi.uk` + `auth-dev.naisi.uk` on dev) have been stable. Then:
  - Add a 301 redirect in `src/proxy.ts` that bounces `Host: naisi-website--naisi-website-dev.europe-west4.hosted.app` → `https://dev.naisi.uk` (same path)
  - Remove `naisi-website--naisi-website-dev.europe-west4.hosted.app` from Firebase Auth → Authorized domains on the dev project
  - Remove any committee bookmarks / internal docs still referencing the old hosted.app URL

## License

MIT — see [LICENSE](./LICENSE). You're free to fork, modify, and adapt this
code (including for your own commercial or non-commercial projects) as long
as you keep the copyright notice.

## Using this?

If you're running a student society, non-profit, or other AI-safety group and
this tooling is useful to you — we'd genuinely love to hear about it. There's
no obligation, but:

- Drop us a line at [ai-safety@uonsu.com](mailto:ai-safety@uonsu.com)
- Or message [@notts.ai.safety](https://instagram.com/notts.ai.safety) on Instagram

We're happy to share what we've learned building this out, trade notes on
running events, or just say hi. The goal was always to make it easier for
more groups to do AI safety outreach — knowing who's picked it up helps us
keep making it better.
