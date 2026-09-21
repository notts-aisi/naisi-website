/**
 * Which flyer a sign-up came from, pinned as a pure function.
 *
 * A printed QR code encodes `naisi.uk/q/<slug>`, the redirect lands it on a
 * page carrying `?q=<slug>`, and the subscribe form turns that into the
 * subscription's `source` at the moment of submitting. The whole of "which
 * material worked" rests on that one string, and the string is built from
 * text the visitor controls: the address bar. So what this suite holds is the
 * shape. A slug is lowercase letters, digits and hyphens, sixteen at most, or
 * it is ignored; an interest is one of a closed list, or it is dropped.
 * Nothing an anonymous visitor types into a URL reaches the admin
 * Subscriptions table as anything but one of the strings listed in
 * `src/lib/campaign/attribution.ts`.
 *
 * It also pins the wiring, because a helper nobody calls is a test of nothing:
 * the form has to call `attributedSource` with the live query string, and
 * whatever answers a short link has to hand the slug on as `?q=`. That was a
 * redirect in `next.config.ts` until the short-link route took over; what the
 * route sends is held by `tests/tracked-links.test.mjs`, and this file keeps
 * the one property that is about the config: no redirect under `/q` may be
 * permanent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { loadTs } = createLoader();
const { attributedSource, campaignSlugFromSearch, isLinkInterest, LINK_INTERESTS } = await loadTs(
  "lib/campaign/attribution.ts",
);

test("a scanned code's slug is read from the query string", () => {
  assert.equal(campaignSlugFromSearch("?q=flyer"), "flyer");
  assert.equal(campaignSlugFromSearch("?utm_source=poster&q=banner-2"), "banner-2");
});

test("a slug somebody retyped in capitals is the same slug", () => {
  assert.equal(campaignSlugFromSearch("?q=FLYER"), "flyer");
  assert.equal(campaignSlugFromSearch("?q=%20Flyer%20"), "flyer");
});

test("anything that is not a slug is ignored, not cleaned up", () => {
  for (const search of [
    "",
    "?",
    "?q=",
    "?other=flyer",
    "?q=a b",
    "?q=a:b",
    "?q=a/b",
    "?q=<script>",
    "?q=seventeen-chars-x",
    "?q=%00",
    "?q=fl%C3%BFer",
  ]) {
    assert.equal(campaignSlugFromSearch(search), null, `${JSON.stringify(search)} was accepted`);
  }
});

test("sixteen characters is the longest slug", () => {
  assert.equal(campaignSlugFromSearch("?q=sixteen-chars-xx"), "sixteen-chars-xx");
});

test("with no code, the form's own label is the source", () => {
  assert.equal(attributedSource({ source: "homepage", search: "" }), "homepage");
  assert.equal(attributedSource({ source: "links", search: "?utm_source=ig" }), "links");
});

test("a code takes the place of the page the form sits on", () => {
  assert.equal(attributedSource({ source: "homepage", search: "?q=flyer" }), "qr:flyer");
  assert.equal(attributedSource({ source: "links", search: "?q=flyer" }), "qr:flyer");
});

test("an interest is appended to either", () => {
  assert.equal(
    attributedSource({ source: "links", search: "", interest: "fellowship" }),
    "links:fellowship",
  );
  assert.equal(
    attributedSource({ source: "links", search: "?q=banner", interest: "incubator" }),
    "qr:banner:incubator",
  );
});

test("an interest outside the closed list is dropped", () => {
  for (const interest of ["", "Fellowship", "fellowship ", "admin", "a:b", null, undefined]) {
    assert.equal(attributedSource({ source: "links", search: "", interest }), "links");
  }
  assert.deepEqual([...LINK_INTERESTS], ["fellowship", "facilitator", "incubator"]);
  assert.equal(isLinkInterest("facilitator"), true);
  assert.equal(isLinkInterest(7), false);
});

test("every string it can build fits the route's 80 character clamp", () => {
  for (const interest of LINK_INTERESTS) {
    const longest = attributedSource({ source: "links", search: "?q=sixteen-chars-xx", interest });
    assert.ok(longest.length <= 80, `${longest} is ${longest.length} characters`);
  }
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test("the subscribe form builds its source from the live query string", () => {
  const form = readFileSync(join(REPO_ROOT, "src/components/SubscribeForm.tsx"), "utf8");
  assert.match(form, /from "@\/lib\/campaign\/attribution"/);
  assert.match(form, /source: attributedSource\(\{[\s\S]*?search: window\.location\.search/);
});

test("no redirect under /q is permanent", () => {
  // `permanent: true` is a 308, which a phone caches for good: whatever it
  // pointed at, that phone could never be sent anywhere else. The entries
  // that remain are the bare prefix and the deeper paths; the slugs themselves
  // are answered by the short-link route.
  const config = readFileSync(join(REPO_ROOT, "next.config.ts"), "utf8");
  const entries = [...config.matchAll(/\{[^{}]*source: "\/q[^"]*"[^{}]*\}/g)].map((m) => m[0]);
  const redirects = entries.filter((entry) => /permanent:/.test(entry));
  assert.ok(redirects.length >= 1, "the /q redirects are missing from next.config.ts");
  for (const entry of redirects) {
    assert.match(entry, /permanent: false/, `a /q redirect is not temporary:\n${entry}`);
  }
});
