# Touch targets

44×44 CSS px minimum for interactive elements on mobile. This is the Apple HIG figure and matches WCAG 2.5.5 (Target Size — Enhanced). Enforcement is partial — the split is deliberate.

## Enforced

The following surfaces must hit 44×44 on every interactive element below `--bp-md`:

- **Public site** — PublicHeader nav + actions, PublicFooter link rows, all CTAs and inline link buttons on landing / members / resources / news / events list pages.
- **AppShell nav** — drawer link rows, top-strip hamburger button.
- **Form controls** — `<Button>` (default size), `<Input>`, `<Select>`, `<Switch>` (including the touch slop area when the visual switch is smaller). All `<label>` elements used as click targets via `cursor: pointer`.
- **Auth pages** — every interactive element on `/login`, `/register`, `/pending-approval`.
- **Events RSVP flow** — already meets this on the public side; verify on each mobile-frozen module touch.

Mechanism: `<Button>` exposes a `size` prop. The default (`md`) carries `min-height: 2.75rem` (44px). `<Input>` / `<Select>` / `<Switch>` carry the same floor. New form fields inherit this automatically.

A `.tappable` utility class in `globals.css` is available for one-off interactive elements that aren't built on the form primitives (custom anchors styled as buttons, etc.).

## Aspirational

The following surfaces are committee-facing tools used predominantly on desktop, where compact UI is a feature. Touch targets are best-effort but not enforced:

- **Admin tables** — per-row action buttons on `/admin/members`, `/admin/subscriptions`, `/admin/deliverability`. These use `<Button size="sm">` (≈36px) by explicit opt-in.
- **`<SegmentedControl>` options** — filter chips in admin tables; small by default, with a `size="md"` opt-in available for callers that need the larger target.
- **Task board card inline controls** — committee task management is desktop-shaped; phone use is best-effort. Card-level tap target (whole card) is enforced; per-card inline actions are not.
- **Rich-text editor toolbars** — newsletter and event editors. Editing on phone is a degraded experience by design.

## Why the split

44px floor on member-facing surfaces protects the largest user group (members RSVPing for events, browsing resources, reading news). Aspirational on dense admin surfaces avoids a sweeping table-row reflow that would harm the desktop experience of the smaller committee group, who can comfortably use the existing compact UI.

When in doubt: if the surface is in `(public)` or `(auth)` or in the member-facing parts of `(app)` (dashboard, profile, tasks/my-work), enforce. If it's a committee/admin tool, aspirational.

## Audit checklist

When touching any of the enforced surfaces, verify at 375px DevTools (and on a real device when possible):

- Tappable elements visibly accept touch — no need to aim precisely.
- Stacked buttons / links have ≥ 8px of breathing room between them so adjacent targets are distinguishable.
- Form field labels are tappable along their full width (the input is reached by tapping the label).
- Nested links / buttons (e.g. a card that is itself a link with an inner action button) do not have overlapping tap zones that misroute taps.
