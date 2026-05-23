# Mobile baseline — events RSVP

The public events RSVP/registration flow is the site's most mobile-mature surface. It is the hard "do not regress" surface for the mobile-friendliness initiative. This document is the contract.

## Mobile-frozen modules

These CSS modules back the public events flow. Any PR that touches them — or touches a shared token (`tokens.css`, `typography.css`, breakpoints) that they consume — must re-verify the baseline below before merging.

- [src/features/events/EventDetailView.module.css](../src/features/events/EventDetailView.module.css)
- [src/features/events/RsvpForm.module.css](../src/features/events/RsvpForm.module.css)
- [src/features/events/BlockView.module.css](../src/features/events/BlockView.module.css)
- [src/features/events/FormRenderer.module.css](../src/features/events/FormRenderer.module.css)
- [src/features/events/CoverImage.module.css](../src/features/events/CoverImage.module.css)

The components consuming these modules live in `src/features/events/` and are rendered by the public route `src/app/(public)/events/[id]/` and its sub-routes (`rsvp/[rsvpId]/change`, `rsvp/[rsvpId]/cancel`, `rsvp/submitted`).

## Viewports to verify at

- **375 × 667** — iPhone SE / iPhone 12 mini portrait. The narrow-phone reference.
- **414 × 896** — iPhone Plus / Pro Max portrait. Most-common large phone.
- **768 × 1024** — iPad portrait. The exact `--bp-md` boundary; verify the layout transition is clean.
- **1024 × 1366** — iPad landscape / small laptop. Above `--bp-lg`; should match desktop.

## Flows to re-run

For each viewport above, walk through:

1. **Anonymous RSVP submit.** Open `/events/[id]` on a draft event. Fill the RSVP form (name, email, custom questions). Submit. Confirmation page renders.
2. **Signed-in RSVP submit.** Same as above but signed in as a member. Form prefills name/email. Submit. Confirmation page renders.
3. **RSVP change request.** From a confirmation page, click "Change my answers." Modify a field. Submit. Confirmation that change is pending.
4. **RSVP self-cancel.** From a confirmation page, click "Cancel my RSVP." Confirm. Cancellation page renders.

## What "still works" means

- **No horizontal page scroll** at any viewport. Internal-scrolling containers (none in this flow currently) are the exception.
- **No clipped controls.** Every form field, button, and link is fully visible and tappable.
- **Sticky RSVP panel does not cover content** at viewports where it remains sticky. Below `--bp-md` it should be static (already implemented in EventDetailView at the 880px breakpoint; normalising to `--bp-md` is the high-risk change tracked in PR 7).
- **All form inputs accept text** and the on-screen keyboard does not occlude the field being edited (test on a real iOS device, not just DevTools).
- **Food declaration callout, dietary tags, and capacity/waitlist badges remain legible.**
- **Cover image and emblem branding overlay render at the correct aspect ratio** without distortion.
- **ICS download / calendar links work** from a phone (tap behaviour, not just click).

## Verification checkbox

Every PR description in the `feat/mobile-friendly` track must include:

```
- [ ] Re-verified events RSVP baseline at 375px and 414px
```

For PRs that touch a mobile-frozen module or a shared token, extend to:

```
- [ ] Re-verified events RSVP baseline at 375 / 414 / 768 / 1024
- [ ] Screenshots attached for each flow
```

## When the baseline itself should change

The baseline is not immutable — if a deliberate mobile improvement to the events flow is the goal of a PR, the new behaviour replaces the relevant entry above. Update this document in the same PR.

## Why no snapshot tests

No Playwright / Cypress / Chromatic harness exists in the repo. Standing one up just for this surface is a stage of its own and pulls CI infrastructure onto a public repo. Snapshot tests are also noisy on font loading and user-name strings that vary at test time. The hand-written baseline + a per-PR checkbox catches accidental coupling at the same scale as the site, with less ceremony. Revisit if Playwright lands for other reasons.
