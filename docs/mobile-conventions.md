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

## Don't regress the events RSVP flow

The events RSVP page is the site's most mobile-mature surface and must not regress. See [mobile-baseline-events.md](mobile-baseline-events.md) for the regression contract.

## Safe-area insets

`viewport: { viewportFit: "cover" }` in [src/app/layout.tsx](../src/app/layout.tsx) engages iOS safe-area insets. Any `position: fixed` element near a viewport edge should respect:

```css
padding-top: env(safe-area-inset-top);
padding-bottom: env(safe-area-inset-bottom);
```

Currently relevant to: the impersonation banner (sticky-top in AppShell) and any future drawer or sheet anchored to the viewport edges.
