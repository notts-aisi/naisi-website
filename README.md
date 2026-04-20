# NAISI — Nottingham AI Safety Initiative

The NAISI website. Public marketing site + authed committee tooling (tasks, credentials store, 1-1 booking calendar, admin approvals).

## Stack

- **Next.js 16** (App Router, TypeScript)
- **React 19**
- **Firebase** — Auth (Google Sign-In), Firestore, App Hosting
- **No UI framework** — CSS modules + theme tokens in `src/theme/tokens.css` so re-theming is a one-file swap

## v1 scope

- Public: Landing, Members, Resources, News digest
- Auth: `/login`, `/register` (Google + profile form), `/pending-approval`
- Authed: Dashboard shell (tasks/credentials/calendar/admin pages coming next session)
- Admin approval flow via `users/{uid}.role` transitions

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

The first admin can't promote themselves from the UI (no admin UI yet), so set it manually in Firestore:

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

## Project layout

The key folders:

- `src/app/` — App Router routes. Route groups:
  - `(public)/` — marketing site (uses `PublicHeader` + `PublicFooter`)
  - `(auth)/` — login/register/pending-approval
  - `(app)/` — authed area, server-side role-gated in its `layout.tsx`
  - `api/auth/session/` — session cookie mint/clear
- `src/theme/tokens.css` — **one file** to swap the entire colour palette
- `src/components/BrandMark.tsx` — placeholder logo; replace this one file when the real brand asset arrives
- `src/lib/firebase/` — `client.ts` (browser), `admin.ts` (server), `session.ts` (cookie + `getCurrentUser()`)
- `src/auth/` — `AuthProvider`, `signInWithGoogle`, `completeRegistration`
- `src/features/` — feature-scoped data + hooks (news, members so far)
- `src/proxy.ts` — Next 16's middleware (renamed). Fast session-cookie presence check; the real role gate is in `(app)/layout.tsx`

## Theming

Edit `src/theme/tokens.css`. Every component reads `var(--color-*)` so changes propagate everywhere.

Light theme: change `data-theme="dark"` to `"light"` in [src/app/layout.tsx](src/app/layout.tsx).

## Brand asset placeholder

[src/components/BrandMark.tsx](src/components/BrandMark.tsx) is an inline SVG placeholder. When the real Nottingham castle + shield + human head design arrives, replace just this file and `public/favicon.svg`.

## What's next (not in v1)

- Task manager (board view, progress bars)
- Credentials store (client-side AES-GCM, PBKDF2-derived key)
- 1-1 booking calendar (Firestore availability + transactions)
- Admin dashboard (Approvals / Members / Projects tabs)
- Course & homework viewer (BlueDot-style)
