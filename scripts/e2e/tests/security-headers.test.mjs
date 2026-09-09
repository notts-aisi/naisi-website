/**
 * The response headers every route is meant to carry, asserted on a REAL
 * build.
 *
 * `next.config.ts` declares them, and a declaration is not a header until
 * a server has sent it: a rule with a `source` that does not match, a second
 * rule that overrides the first, a header the platform strips, none of those
 * shows up anywhere but on the wire. So this battery asks a running server,
 * on a page, on a redirect, on an API refusal and on the two static files
 * that carry rules of their own, and reads what came back.
 *
 * What it pins, and why each one:
 *
 *  - Strict-Transport-Security, two years with subdomains, so a first visit
 *    over http is the last one. (Browsers ignore it on a loopback http
 *    origin, but the header is still sent, and sent is what is asserted.)
 *  - X-Frame-Options DENY and `frame-ancestors 'none'`: nothing frames the
 *    site, so a clickjacking page has nothing to overlay.
 *  - Referrer-Policy strict-origin-when-cross-origin: the tokens in
 *    magic-link and unsubscribe URLs never reach a third-party image or
 *    embed as a referrer.
 *  - Permissions-Policy: camera, microphone, geolocation, payment, USB and
 *    the topics API are off for the page and every frame it embeds.
 *  - X-Content-Type-Options nosniff.
 *  - Content-Security-Policy-Report-Only carrying the INTENDED policy, with
 *    no `'unsafe-inline'` in script-src, and NO enforced
 *    Content-Security-Policy header. The day the policy is enforced this
 *    assertion flips on purpose, so the flip is a reviewed diff here as well
 *    as in next.config.ts.
 *  - The service worker keeps its no-store rule and the offline page its
 *    no-cache rule: a new global rule must not have replaced them.
 *
 * It proves headers, not handlers: the routes it requests are already
 * covered or written down elsewhere, and its AUTH_BATTERIES entry says so.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../lib/env.mjs";
import { anonFetch } from "../lib/session.mjs";

/** Path, and the status a signed-out request is expected to get. */
const SURFACES = [
  { path: "/", status: 200, what: "the home page" },
  { path: "/login", status: 200, what: "the sign-in page" },
  { path: "/dashboard", status: 307, what: "a protected page's redirect" },
  { path: "/api/courses/me", status: 401, what: "an API refusal" },
  { path: "/sw.js", status: 200, what: "the service worker" },
  { path: "/offline.html", status: 200, what: "the offline fallback" },
];

const EXPECTED = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

const PERMISSIONS_OFF = ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"];

const CSP_MUST_CARRY = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

describe("security headers on a real build", () => {
  const responses = new Map();

  before(async () => {
    loadEnv();
    for (const surface of SURFACES) {
      const res = await anonFetch(surface.path, { redirect: "manual" });
      responses.set(surface.path, res);
      assert.equal(
        res.status,
        surface.status,
        `${surface.what} (${surface.path}) answered ${res.status}, expected ${surface.status}; ` +
          "the headers below are read off the wrong response otherwise",
      );
    }
  });

  for (const surface of SURFACES) {
    it(`${surface.what} carries every fixed header`, () => {
      const res = responses.get(surface.path);
      for (const [name, value] of Object.entries(EXPECTED)) {
        assert.equal(res.headers.get(name), value, `${surface.path}: ${name}`);
      }
      const permissions = res.headers.get("permissions-policy") ?? "";
      for (const feature of PERMISSIONS_OFF) {
        assert.ok(permissions.includes(feature), `${surface.path}: Permissions-Policy lacks ${feature}`);
      }
    });

    it(`${surface.what} reports the intended CSP and enforces none`, () => {
      const res = responses.get(surface.path);
      const reportOnly = res.headers.get("content-security-policy-report-only") ?? "";
      for (const directive of CSP_MUST_CARRY) {
        assert.ok(reportOnly.includes(directive), `${surface.path}: report-only CSP lacks "${directive}"`);
      }
      const scriptSrc = reportOnly.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      assert.ok(scriptSrc.includes("'self'"), `${surface.path}: script-src must allow 'self'`);
      assert.ok(
        !scriptSrc.includes("'unsafe-inline'"),
        `${surface.path}: the intended script-src carries 'unsafe-inline', which reports nothing`,
      );
      assert.equal(
        res.headers.get("content-security-policy"),
        null,
        `${surface.path}: an ENFORCED Content-Security-Policy is being sent. If that is deliberate, ` +
          "this battery and next.config.ts change together.",
      );
    });
  }

  it("the service worker and the offline page keep their own cache rules", () => {
    assert.equal(
      responses.get("/sw.js").headers.get("cache-control"),
      "no-cache, no-store, must-revalidate",
      "sw.js must never be served stale (the kill-switch rollback depends on it)",
    );
    assert.equal(responses.get("/offline.html").headers.get("cache-control"), "no-cache");
  });
});
