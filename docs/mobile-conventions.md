# Mobile conventions

The NAISI site was built desktop-first. This document codifies how mobile responsiveness is added now and how new features should handle it going forward.

## Going-forward rule

**Features ship desktop-first on their own branch into `dev`. Mobile adaptations land in a separate follow-up PR per feature.**

Mixing mobile and desktop concerns in the same PR has historically muddled both. The split keeps each PR's scope tight and lets the desktop design settle before a mobile version is fitted to it.

The minimum bar for a feature PR on `dev`: it must not actively break below 360px — content scrolls vertically (not horizontally), no controls are clipped, nothing is unreachable. It does not have to be pretty on mobile at landing; that's the follow-up PR's job.

## Desktop-first with a mobile-adapt block

The codebase is desktop-first throughout. Inverting to mobile-first now would force flipping every existing module, with high blast radius on intermediate-width behaviour. The convention stays desktop-first and adds a single pattern for adapting:

**Every CSS module ends with one `@media (max-width: Xrem)` block** containing the mobile overrides for that component. Not interleaved through the file — at the bottom, easy to audit, easy to remove if a layout is rebuilt.

New CSS modules ship with the block present even if it is empty:

```css
.foo {
  /* …desktop styles… */
}

/* === Mobile === */
@media (max-width: 48rem) { /* --bp-md */
  /* TODO: mobile pass */
}
```

The placeholder forces the question "what does this look like on a phone" at design time without forcing the answer.

## Breakpoints

Four canonical breakpoints. Use the literal `rem` value in CSS, and tag it with a trailing comment so the name is greppable.

| Name | Value | Use |
| ---- | ----- | --- |
| `sm` | 36rem (576px) | small phone landscape / large phone portrait |
| `md` | 48rem (768px) | phone ↔ tablet split — the most-used breakpoint in the codebase |
| `lg` | 60rem (960px) | tablet ↔ laptop split — sidebar collapse, hero emblem cutover |
| `xl` | 80rem (1280px) | wide-laptop — reserved for wide-data views |

In CSS:

```css
@media (max-width: 48rem) { /* --bp-md */
  …
}
```

In TypeScript (matchMedia, JS-driven responsive logic):

```ts
import { BREAKPOINTS, maxWidth } from "@/theme/breakpoints";

const mq = window.matchMedia(maxWidth("md"));
```

The canonical set is defined in [src/theme/breakpoints.ts](../src/theme/breakpoints.ts) and mirrored as a comment block at the top of [src/theme/tokens.css](../src/theme/tokens.css).

### Why not CSS custom properties for breakpoints

CSS custom properties (`var(--bp-md)`) do not work inside `@media` query conditions. The spec resolves custom properties at computed-value time — after media has already been matched. `@media (max-width: var(--bp-md))` silently does nothing and breaks layout with no error.

### Why not `postcss-custom-media`

The PostCSS `custom-media` plugin would let us write `@media (--md)`, but adding it to Next 16's Turbopack pipeline introduces a build-tooling surface that has historically caused trouble (see `next.config.ts` for an existing Turbopack workspace-root pin added to dodge a related class of issue). The payoff — slightly tidier media queries — is not worth the integration cost.

### Why not native `@custom-media`

Draft spec, not in any stable browser. Not viable.

## Touch targets

44×44 CSS px minimum for interactive elements (Apple HIG / WCAG 2.5.5). See [touch-targets.md](touch-targets.md) for the enforced-vs-aspirational split and the specific files that comply or are exempt.

## The applicant funnel has its own device walk

The courses funnel (catalogue, programme page, apply form, availability grid,
status hub) is walked on real hardware before an admission round opens. The
ordered steps, and which module governs each one, are in
[mobile-funnel-checklist.md](mobile-funnel-checklist.md).

## Don't regress the events RSVP flow

The events RSVP page is the site's most mobile-mature surface and must not regress. See [mobile-baseline-events.md](mobile-baseline-events.md) for the regression contract.

## Safe-area insets

`viewport: { viewportFit: "cover" }` in [src/app/layout.tsx](../src/app/layout.tsx) engages iOS safe-area insets, and it is on for **every** route. Next's `mergeViewport` overrides per key and only for keys physically present on a child's viewport export, so `(auth)/layout.tsx` declaring `width` / `initialScale` / `maximumScale` / `userScalable` inherits `viewportFit` rather than clearing it.

The consequence is worth stating plainly: every surface on this site already draws to the physical screen edges. A missing inset is a live bug in an ordinary Safari tab, not something that only appears once the site is installed. Installing just makes it permanent, because there is no browser chrome to absorb it.

### The idiom

Always wrap the inset so it is inert where there is none. `env()` resolves to `0px` on every desktop, every non-notched device and in DevTools, so both of these are byte-identical there:

```css
/* Where the element already has padding: take whichever is larger. */
padding-left: max(var(--space-4), env(safe-area-inset-left, 0px));

/* Where the inset must ADD to a fixed dimension rather than replace it. */
height: calc(3.5rem + env(safe-area-inset-top, 0px));
```

Always pass the `0px` fallback. Bare `env(safe-area-inset-top)` is invalid in a `calc()` on older WebKit and drops the whole declaration.

**The trap that actually bit us.** `globals.css` sets `box-sizing: border-box` globally. Pairing a fixed `height` with `padding-top: env(...)` therefore makes the inset *eat* the content box instead of growing it. AppShell's mobile top strip had `height: 3.5rem` with `padding-top: env(safe-area-inset-top)`, so on a notched iPhone in landscape a 59px inset against a 56px box left nothing for the 44px hamburger. If an element has a fixed height, add the inset to the height too.

### Where they are handled

Viewport-pinned and edge-anchored surfaces own their own insets:

- Root chrome: `PublicHeader` (top, sides), `PublicFooter` (bottom), the `(auth)` shell (top, sides), `globals.css` `.container` (sides)
- `AppShell`: the mobile top strip (top, sides), the fixed sidebar (left, bottom), the floating collapse pill (top, right), the main content area (sides, bottom), the impersonation banner (offset by the strip's full height)
- Overlays: `Drawer`, `Dropdown`, `PersonSelector`, `TaskDetailModal`, `SubtaskDetailModal`, `AdminTabs`, `SiteNoticeBanner`, the register sticky action bar

### Two deliberate non-decisions

`overscroll-behavior-y: none` is **not** set. It would look like the obvious way to kill rubber-band scrolling in a standalone window, but Android installed apps support pull-to-refresh and in a standalone window that is the *only* reload gesture the user has. AppShell's top strip carries an explicit reload button when `html[data-standalone]` is set instead.

`interactiveWidget: "resizes-content"` on the root viewport is untested and unshipped. It plausibly improves what stays reachable when the soft keyboard opens over the height-pinned `(auth)` shell, but it changes behaviour for browser visitors too and cannot be judged without a real device. Test it during the next device pass before adopting it.
