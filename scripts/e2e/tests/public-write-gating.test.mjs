/**
 * PRODUCTION SAFETY CHECK — is the reCAPTCHA gate on the public RSVP really
 * live, on every deployed backend?
 *
 * `POST /api/events/[id]/rsvp` writes an `eventRsvps` row and posts a
 * NAISI-branded email, from the society's own DKIM-aligned sender, to an
 * address the caller typed. Until 9 September 2026 nothing stood between a
 * stranger and that: no session on a public event, no reCAPTCHA, no throttle.
 * It is gated now, but a source scan cannot see whether the gate is running on
 * a given backend, so this asks the server.
 *
 * ## What it proves, and what it does not
 *
 * It proves the gate is not OPEN: a junk token is refused. It cannot prove the
 * gate is not JAMMED SHUT, because `verifyRecaptcha` fails closed in
 * production when `RECAPTCHA_SECRET` is missing and a failed-closed gate
 * answers a junk token with exactly the same 400 as a working one. A backend
 * missing the secret, or missing the public site key so the form mounts no
 * widget, is therefore green here while every real RSVP on it is refused.
 * That direction is what the browser suite is for: the events RSVP spec drives
 * a guest through a real submission, and it runs in full against a local build
 * on every CI run. Said out loud because a battery that claims both directions
 * and delivers one is worse than one that claims the direction it has.
 *
 * The sibling `recaptcha-gate.test.mjs` asks the same question of
 * `/api/register`, and this file is deliberately its twin rather than an
 * addition to it: the two routes carry the secret independently, and a check
 * that proved one and implied the other is the assumption that lets the second
 * one drift.
 *
 * ## Why this is safe to point at production
 *
 * It posts a junk token to an event id that cannot exist, and the gate runs
 * BEFORE the event is fetched, so the request is refused at the captcha and
 * nothing is read, written or sent either way. A 404 back means the captcha did
 * NOT run first, and this skips loudly rather than guessing why: from out here
 * a backend that predates the gate and one whose gate has moved behind the
 * event lookup look identical. The ordering is pinned against the source by
 * `tests/public-write-gating.test.mjs`; liveness is what this file is for.
 *
 * Read-only, no credentials, no side effects. Runs on every `npm run e2e`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BACKENDS = [
  { name: "dev", origin: "https://dev.naisi.uk" },
  { name: "production", origin: "https://naisi.uk" },
];

describe("the public RSVP bot gate is live on every deployed backend", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name} rejects an RSVP with a junk reCAPTCHA token`, async (t) => {
      // An id no event can have: `slugId` ids are a title slug plus base36, and
      // this one names itself. If the gate ever stopped running first, this
      // would come back 404 rather than accepting anything.
      const eventId = `e2e-rsvp-gate-probe-${Date.now()}`;
      let res;
      try {
        res = await fetch(`${backend.origin}/api/events/${eventId}/rsvp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "E2E gate probe",
            // `.invalid` cannot receive mail, so even a total gate failure
            // could not deliver anything to a person.
            email: `e2e-rsvp-gate-probe-${Date.now()}@e2e.invalid`,
            answers: {},
            recaptchaToken: "e2e-deliberately-invalid-token",
          }),
        });
      } catch (err) {
        return t.skip(`${backend.origin} unreachable (${err.message})`);
      }

      const body = await res.text();

      if (res.status === 404) {
        // The gate is not live on this backend. Either the route predates it
        // (this check arms itself when the change rolls out) or the event
        // lookup is running first, which would put the gate behind the work it
        // exists to bound. This cannot tell those apart from out here, so it
        // says so and skips rather than guessing: the ORDERING is pinned
        // against the source by `tests/public-write-gating.test.mjs`, and
        // liveness is what this file is for.
        return t.skip(
          `${backend.origin}/api/events/[id]/rsvp answered 404 to a junk token, so the ` +
            "captcha did not run first on this backend. Expected until the gate rolls out; " +
            "if it persists after a deploy, the gate has moved behind the event lookup.",
        );
      }

      if (res.status === 429) {
        return t.skip(
          `${backend.origin} answered 429: a rate limit spoke before the captcha. That is the ` +
            "other half of the gate working. Rerun later to exercise the captcha itself.",
        );
      }

      assert.notEqual(
        res.status,
        200,
        `${backend.origin}/api/events/[id]/rsvp accepted a junk reCAPTCHA token. The gate is ` +
          "NOT active on this backend, most likely because RECAPTCHA_SECRET is missing from " +
          "it. That endpoint writes attendee rows and sends mail from a DKIM-aligned sender; " +
          "treat this as urgent.",
      );
      assert.equal(
        res.status,
        400,
        `Expected 400 from ${backend.origin}, got ${res.status} (${body.slice(0, 160)}). ` +
          "Anything else means the failure mode has changed and this check needs revisiting.",
      );
      assert.match(
        body,
        /human/i,
        `Expected the reCAPTCHA rejection from ${backend.origin}, but got a different 400: ` +
          `${body.slice(0, 160)}. The request may be dying before the gate, which would make ` +
          "this test green without proving anything.",
      );
    });
  }
});
