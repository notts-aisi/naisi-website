/**
 * Pins the SERVER-SIDE contract that the client-side navigation fix depends on.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN. This file would have passed
 * throughout the entire lifetime of the bug it was written alongside, and it
 * will pass if that fix is reverted. It cannot catch the bug. The bug lives in
 * Next's client route cache — `router.replace` onto a URL that 307'd earlier
 * in the same document replays the recorded redirect with no network request —
 * and this harness is `node --test` + `fetch` with no browser, so there is no
 * route cache, no router, and no document here to break.
 *
 * What it DOES guard is the contract the fix reasons from, and whose silent
 * change would make that reasoning wrong without anyone noticing:
 *
 *   1. Protected routes 307 to /login?next=<path> when the cookie is absent.
 *      This redirect is what poisons the client route cache, and `?next=` is
 *      what src/app/(auth)/AuthEntry.tsx treats as evidence that a protected
 *      route already redirected in this document.
 *   2. POST /api/auth/session mints a real __session cookie. The self-heal's
 *      whole premise.
 *   3. With that cookie the PROXY GATE OPENS — the request is no longer sent
 *      to /login. This is the assertion that a console `fetch('/dashboard')`
 *      proved by hand while a user sat wedged on the login page.
 *   4. DELETE clears it and the gate closes again.
 *
 * Note on (3): a harness session deliberately has NO Firestore user document
 * (see lib/session.mjs), so it has no role and (app)/layout.tsx will bounce it
 * onward to /pending-approval. That is expected and fine — the assertion here
 * is specifically "not sent back to /login", i.e. the proxy's cookie check
 * passed. Asserting 200 would be asserting a role this harness has no business
 * creating.
 *
 * If this bug ever recurs, the only automated coverage that could catch it is
 * a real browser (Playwright), which this harness deliberately excludes.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, runId } from "../lib/env.mjs";
import { anonFetch, authedFetch, withHarnessSession } from "../lib/session.mjs";

/** Mirrors PROTECTED_PREFIXES in src/proxy.ts. Keep the two in step. */
const PROTECTED = [
  "/dashboard",
  "/tasks",
  "/credentials",
  "/calendar",
  "/profile",
  "/newsletter",
  "/admin",
  "/collaborator",
];

describe("protected-route gate (the contract the client nav fix relies on)", () => {
  let session;

  before(async () => {
    loadEnv();
    session = await withHarnessSession(runId());
  });

  after(async () => {
    if (session) await session.dispose();
  });

  for (const path of PROTECTED) {
    it(`redirects ${path} to /login?next= when no cookie is present`, async () => {
      const res = await anonFetch(path, { redirect: "manual" });
      assert.equal(
        res.status,
        307,
        `${path} should 307 for an anonymous request, got ${res.status}`,
      );
      const location = res.headers.get("location") ?? "";
      const target = new URL(location, "https://placeholder.invalid");
      assert.equal(
        target.pathname,
        "/login",
        `${path} should redirect to /login, got ${location}`,
      );
      assert.equal(
        target.searchParams.get("next"),
        path,
        `${path} should carry itself as ?next=, got ${location}`,
      );
    });
  }

  it("mints a __session cookie that opens the proxy gate", async () => {
    // withHarnessSession already asserts the cookie came back at all; this
    // pins what the cookie is FOR.
    assert.ok(
      session.cookie.startsWith("__session="),
      "harness session should be a __session cookie",
    );

    const res = await authedFetch(session.cookie, "/dashboard", {
      redirect: "manual",
    });

    // The harness identity has no users doc, so (app)/layout.tsx may still
    // redirect it onward. What must NOT happen is a bounce back to /login:
    // that would mean the cookie did not satisfy the gate.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      const target = new URL(location, "https://placeholder.invalid");
      assert.notEqual(
        target.pathname,
        "/login",
        "a freshly minted session must not be bounced back to /login — " +
          "the self-heal in AuthEntry.tsx depends on this holding",
      );
    } else {
      assert.equal(res.status, 200, `unexpected status ${res.status}`);
    }
  });

  it("closes the gate again after DELETE /api/auth/session", async () => {
    const del = await authedFetch(session.cookie, "/api/auth/session", {
      method: "DELETE",
    });
    assert.equal(del.status, 200, "DELETE /api/auth/session should succeed");

    // The cookie value is now revoked server-side (revokeAndClearSession bumps
    // validSince, and getCurrentUser verifies with checkRevoked: true), so
    // replaying it must not get past the layout gate.
    const res = await authedFetch(session.cookie, "/dashboard", {
      redirect: "manual",
    });
    const location = res.headers.get("location") ?? "";
    const target = location
      ? new URL(location, "https://placeholder.invalid")
      : null;
    assert.ok(
      target?.pathname === "/login",
      `a revoked session should land back on /login, got ${res.status} ${location}`,
    );
  });
});
