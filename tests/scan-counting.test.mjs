/**
 * Scan counting for printed QR codes.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * A QR code on a poster encodes `naisi.uk/q/<slug>`. The redirects in
 * `next.config.ts` answer the scan and land it on a page carrying `?q=<slug>`;
 * `ScanBeacon`, mounted in the root layout, then posts to
 * `/api/q/<slug>/scan`, which increments a per-code per-day counter. Four
 * promises hold that arrangement together, and each one is held here by
 * running the code that ships rather than by describing it:
 *
 *  1. PAPER IS PERMANENT. A slug that has been printed is never removed,
 *     renamed or reused. The list below is the record of what is on paper; a
 *     new code is added to it, and nothing already in it may change.
 *  2. NOTHING ABOUT A PERSON IS KEPT. The counter's write is executed against
 *     a fake database and its fields compared with a closed list. The privacy
 *     policy says request logs are not used for analytics and lists every
 *     cookie and storage key the site sets, so neither the route nor the
 *     beacon may read a header that identifies a device or touch browser
 *     storage. That is what lets this ship with the policy unchanged.
 *  3. ONLY A REAL CODE IS COUNTED, AND ONLY BY A POST. The route is driven
 *     through every branch. A GET that counted would count link previews and
 *     mail scanners; `tests/get-handlers-readonly.test.mjs` refuses any GET
 *     that calls `recordScan`, and this file checks that entry is still there.
 *  4. COUNTING NEVER BREAKS THE PAGE. The beacon is the one piece of this that
 *     runs on a page somebody has just opened at a stall.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const codeOf = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * What is on paper. Each of these has been printed and handed out, so an
 * entry here is never edited or removed. Add a line when a new code is
 * printed.
 */
const ON_PAPER = ["movie", "brochure", "poster", "join", "ig"];

/** Every field `recordScan` may write. Widening this is a privacy decision. */
const STORED_FIELDS = ["count", "date", "hours", "slug"];

// ---------------------------------------------------------------------------
// The fake database the shipping code is run against
// ---------------------------------------------------------------------------

const writes = [];
globalThis.__scanFakeDb = {
  collection(collection) {
    return {
      doc(id) {
        return {
          async set(data, options) {
            if (globalThis.__scanWriteFails) throw new Error("firestore is down");
            writes.push({ collection, id, data, options });
          },
        };
      },
    };
  },
};

const STUBS = [
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = {\n" +
      "  json(body, init) {\n" +
      "    return { status: (init && init.status) || 200, body, headers: (init && init.headers) || {} };\n" +
      "  },\n};",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = { increment: (by) => ({ __op: 'increment', by }) };",
  ],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() {\n  return globalThis.__scanDbMissing ? undefined : globalThis.__scanFakeDb;\n}",
  ],
];

const { loadTs } = createLoader({ stubs: STUBS });
const { PRINTED_LINKS, isPrintedSlug } = await loadTs("lib/campaign/printedLinks.ts");
const { isCampaignSlug, campaignSlugFromSearch } = await loadTs("lib/campaign/attribution.ts");
const { scanBucket, scanDayDocId } = await loadTs("lib/campaign/scanBuckets.ts");
const { scanToCount, COUNTED_PARAM } = await loadTs("lib/campaign/scanBeacon.ts");
const { recordScan, SCAN_DAYS_COLLECTION } = await loadTs("lib/campaign/scanCounter.ts");
const route = await loadTs("app/api/q/[slug]/scan/route.ts");

const INC = { __op: "increment", by: 1 };

beforeEach(() => {
  writes.length = 0;
  globalThis.__scanWriteFails = false;
  globalThis.__scanDbMissing = false;
});

// A fresh address per call, so one test's hits never land in another's bucket.
let caller = 0;
function post(slug, ip) {
  caller += 1;
  const address = ip ?? `203.0.113.${caller}`;
  const req = new Request(`https://naisi.uk/api/q/${slug}/scan`, {
    method: "POST",
    headers: { "x-forwarded-for": `${address}, 10.0.0.1` },
  });
  return route.POST(req, { params: Promise.resolve({ slug }) });
}

// ---------------------------------------------------------------------------
// 1. Paper is permanent
// ---------------------------------------------------------------------------

describe("a printed slug is permanent", () => {
  test("every code on paper is still in PRINTED_LINKS", () => {
    const slugs = PRINTED_LINKS.map((link) => link.slug);
    for (const slug of ON_PAPER) {
      assert.ok(
        slugs.includes(slug),
        `"${slug}" is printed on material that has been handed out and is missing from ` +
          "PRINTED_LINKS. A printed slug is never removed or renamed.",
      );
    }
  });

  test("every entry in PRINTED_LINKS is written down here as on paper", () => {
    // The other direction: a code added to the table is added to the record
    // too, so the record cannot fall behind what has been printed.
    const unrecorded = PRINTED_LINKS.map((link) => link.slug).filter((s) => !ON_PAPER.includes(s));
    assert.deepEqual(unrecorded, [], "add these to ON_PAPER in this file");
  });

  test("each is a well-formed slug, listed once, with a label", () => {
    const seen = new Set();
    for (const { slug, label } of PRINTED_LINKS) {
      assert.ok(isCampaignSlug(slug), `"${slug}" is not a slug the short links accept`);
      assert.ok(!seen.has(slug), `"${slug}" is listed twice`);
      seen.add(slug);
      assert.ok(label.trim().length >= 5, `"${slug}" needs a label saying what it is printed on`);
    }
  });

  test("the list cannot be edited at runtime", () => {
    assert.ok(Object.isFrozen(PRINTED_LINKS));
  });

  test("the short links are still answered by next.config.ts, which this feature leaves alone", () => {
    // Counting is additive. The day a route takes over answering /q/<slug>,
    // these entries have to go in the same change (a redirect is matched
    // before any route and would silently shadow it), and this test is the
    // place that change has to come and say so.
    const config = read("next.config.ts");
    assert.match(config, /source: "\/q\/:slug",\s*destination: "\/links\?q=:slug",\s*permanent: false/);
  });
});

// ---------------------------------------------------------------------------
// 2. Nothing about a person is kept
// ---------------------------------------------------------------------------

describe("what a scan writes", () => {
  test("one increment on the code's document for the London day, and nothing else", async () => {
    // 10:30 UTC on 21 September is 11:30 in London.
    const landed = await recordScan("poster", new Date("2026-09-21T10:30:00Z"));
    assert.equal(landed, true);
    assert.deepEqual(writes, [
      {
        collection: "linkScanDays",
        id: "poster__2026-09-21",
        data: { slug: "poster", date: "2026-09-21", count: INC, hours: { 11: INC } },
        options: { merge: true },
      },
    ]);
    assert.equal(SCAN_DAYS_COLLECTION, "linkScanDays");
  });

  test("the written fields are a closed list", async () => {
    await recordScan("movie", new Date("2026-09-24T17:05:00Z"));
    assert.deepEqual(
      Object.keys(writes[0].data).sort(),
      STORED_FIELDS,
      "recordScan writes a field that is not on the closed list. Anything that says something " +
        "about the person scanning (an address, a device, a referrer, an account, a time finer " +
        "than the hour) changes what the privacy policy has to say.",
    );
  });

  test("a write that fails is swallowed and reported, never thrown", async () => {
    globalThis.__scanWriteFails = true;
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(await recordScan("poster"), false);
    } finally {
      console.error = original;
    }
  });

  test("with no Admin SDK configured it does nothing and says so", async () => {
    globalThis.__scanDbMissing = true;
    assert.equal(await recordScan("poster"), false);
    assert.deepEqual(writes, []);
  });

  const PERSONAL = [
    [/user-agent/i, "the user agent"],
    [/referr?er/i, "the referrer"],
    [/\bcookies?\s*\(|document\.cookie|set-cookie/i, "a cookie"],
    [/localStorage|sessionStorage|indexedDB/, "browser storage"],
    [/getCurrentUser|\buid\b/, "the signed-in account"],
  ];
  const SURFACES = [
    "src/app/api/q/[slug]/scan/route.ts",
    "src/lib/campaign/scanCounter.ts",
    "src/lib/campaign/scanBuckets.ts",
    "src/lib/campaign/scanBeacon.ts",
    "src/features/campaign/ScanBeacon.tsx",
  ];
  for (const path of SURFACES) {
    test(`${path} reads nothing that identifies a person or a device`, () => {
      const code = codeOf(path);
      for (const [pattern, what] of PERSONAL) {
        assert.doesNotMatch(code, pattern, `${path} touches ${what}`);
      }
    });
  }

  test("the route reads no request header itself", () => {
    // The address reaches the in-memory throttle through clientIp() and goes
    // no further. A header read in the route is where a device would leak in.
    const code = codeOf("src/app/api/q/[slug]/scan/route.ts");
    assert.doesNotMatch(code, /headers\s*\.\s*get\(|headers\(\)/);
    assert.match(code, /clientIp\(req\)/);
  });

  test("the throttle it relies on keeps its counts in memory", () => {
    // "No stored IP" is only true while this stays true.
    const limiter = codeOf("src/lib/rateLimit.ts");
    assert.doesNotMatch(limiter, /firebase|firestore|getAdminDb/i);
    assert.match(limiter, /new Map</);
  });
});

describe("the day and the hour are London's", () => {
  test("British Summer Time: an evening scan is counted an hour later than UTC says", () => {
    assert.deepEqual(scanBucket(new Date("2026-09-21T10:30:00Z")), { date: "2026-09-21", hour: "11" });
  });

  test("the day rolls over at London midnight, not UTC midnight", () => {
    // 23:30 UTC on the 21st is already 00:30 on the 22nd in London.
    assert.deepEqual(scanBucket(new Date("2026-09-21T23:30:00Z")), { date: "2026-09-22", hour: "00" });
  });

  test("midnight is hour 00, never a twenty-fifth bucket", () => {
    assert.equal(scanBucket(new Date("2026-12-01T00:00:00Z")).hour, "00");
  });

  test("in winter London and UTC agree", () => {
    assert.deepEqual(scanBucket(new Date("2026-12-01T10:15:00Z")), { date: "2026-12-01", hour: "10" });
  });

  test("a document id keeps the slug and the day apart", () => {
    assert.equal(scanDayDocId("poster", "2026-09-21"), "poster__2026-09-21");
    // A slug may carry hyphens and never an underscore, so the halves cannot merge.
    assert.equal(isCampaignSlug("a_b"), false);
  });
});

// ---------------------------------------------------------------------------
// 3. Only a real code is counted, and only by a POST
// ---------------------------------------------------------------------------

describe("POST /api/q/[slug]/scan", () => {
  test("a printed code is counted once and the response says it landed", async () => {
    const res = await post("poster");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, counted: true });
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.slug, "poster");
  });

  test("every code on paper is counted", async () => {
    for (const slug of ON_PAPER) {
      const res = await post(slug);
      assert.equal(res.status, 200, `${slug} answered ${res.status}`);
    }
    assert.deepEqual(writes.map((w) => w.data.slug), ON_PAPER);
  });

  test("a slug somebody retyped in capitals is the same code", async () => {
    const res = await post("POSTER");
    assert.equal(res.status, 200);
    assert.equal(writes[0].data.slug, "poster");
  });

  test("a well-formed slug that was never printed is refused and nothing is written", async () => {
    const res = await post("e2e-missing-slug");
    assert.equal(res.status, 404);
    assert.deepEqual(writes, []);
    assert.equal(isPrintedSlug("e2e-missing-slug"), false);
  });

  for (const bad of ["a_b", "way-too-long-to-be-a-slug", "pos ter", "poster/x", "<script>", "%2e%2e"]) {
    test(`"${bad}" is not a slug: refused before anything is looked up`, async () => {
      const res = await post(bad);
      assert.equal(res.status, 400);
      assert.deepEqual(writes, []);
    });
  }

  test("a failed write still answers 200, and says it did not land", async () => {
    // The beacon never reads the answer. This is for whoever checks a deploy.
    globalThis.__scanWriteFails = true;
    const original = console.error;
    console.error = () => {};
    try {
      const res = await post("poster");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, counted: false });
    } finally {
      console.error = original;
    }
  });

  test("one address is throttled, and a throttled request writes nothing", async () => {
    const ip = "198.51.100.77";
    let last;
    let accepted = 0;
    for (let i = 0; i < 400; i += 1) {
      last = await post("poster", ip);
      if (last.status === 200) accepted += 1;
      else break;
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers["Retry-After"]) >= 1);
    assert.equal(writes.length, accepted);
    // Generous on purpose: a sports hall full of phones shares one address.
    assert.ok(accepted >= 120, `only ${accepted} scans a minute from one address is too tight for a fair`);
  });

  test("the throttle runs before the slug is looked at", () => {
    const code = codeOf("src/app/api/q/[slug]/scan/route.ts");
    const throttle = code.indexOf("rateLimit(");
    assert.ok(throttle > -1);
    assert.ok(throttle < code.indexOf("ctx.params"), "the throttle has to be the first thing the handler does");
    assert.ok(throttle < code.indexOf("recordScan("));
  });

  test("it exports POST and no other method", () => {
    const code = codeOf("src/app/api/q/[slug]/scan/route.ts");
    const methods = [...code.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)].map((m) => m[1]);
    assert.deepEqual(methods, ["POST"]);
  });
});

describe("no GET can count a scan", () => {
  test("recordScan is on the list of helpers a GET handler may never call", () => {
    const guard = read("tests/get-handlers-readonly.test.mjs");
    assert.match(guard, /^\s*recordScan:/m);
    assert.match(guard, /const ALLOWLIST = \[\];/, "the GET guard's allowlist is no longer empty");
  });

  test("recordScan is imported by the counting route and by nothing else in src", () => {
    const importers = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && /\brecordScan\b/.test(readFileSync(full, "utf8"))) {
          importers.push(relative(REPO_ROOT, full).split("\\").join("/"));
        }
      }
    };
    walk(join(REPO_ROOT, "src"));
    assert.deepEqual(importers.sort(), [
      "src/app/api/q/[slug]/scan/route.ts",
      "src/lib/campaign/scanCounter.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Counting never breaks the page
// ---------------------------------------------------------------------------

describe("which page loads count as a scan", () => {
  test("a landing with ?q=<slug> is counted, and the address is marked", () => {
    assert.deepEqual(scanToCount("?q=poster"), { slug: "poster", nextSearch: "?q=poster&counted=1" });
  });

  test("a marked address is never counted again", () => {
    // A phone reloading a tab it had put to sleep, or a friend opening a
    // link somebody copied out of the address bar.
    assert.equal(scanToCount("?q=poster&counted=1"), null);
    assert.equal(COUNTED_PARAM, "counted");
  });

  test("no code, or something that is not a slug, is not a scan", () => {
    for (const search of ["", "?", "?utm_source=ig", "?q=", "?q=a_b", "?q=way-too-long-to-be-a-slug"]) {
      assert.equal(scanToCount(search), null, `"${search}" was counted`);
    }
  });

  test("everything else in the address is kept", () => {
    const next = scanToCount("?q=movie&utm_source=ig")?.nextSearch;
    const params = new URLSearchParams(next);
    assert.equal(params.get("q"), "movie");
    assert.equal(params.get("utm_source"), "ig");
    assert.equal(params.get("counted"), "1");
  });

  test("the mark does not cost a sign-up its attribution", () => {
    // The subscribe form reads ?q= from the address bar when it is submitted,
    // which is after the beacon has rewritten it.
    for (const search of ["?q=poster", "?q=POSTER", "?q=movie&x=1"]) {
      const scan = scanToCount(search);
      assert.equal(campaignSlugFromSearch(scan.nextSearch), scan.slug);
    }
  });
});

describe("the beacon is safe to mount on every page", () => {
  const code = codeOf("src/features/campaign/ScanBeacon.tsx");

  test("it is mounted once, in the root layout", () => {
    const layout = codeOf("src/app/layout.tsx");
    assert.equal([...layout.matchAll(/<ScanBeacon\s*\/>/g)].length, 1);
  });

  test("everything it does is inside a try/catch", () => {
    // An error thrown in an effect reaches the nearest error boundary and
    // replaces the page. Here that is the page somebody just scanned to open.
    const effect = code.slice(code.indexOf("useEffect("));
    const tryAt = effect.indexOf("try {");
    assert.ok(tryAt > -1, "the effect has no try block");
    assert.ok(tryAt < effect.indexOf("scanToCount("), "scanToCount runs outside the try block");
    assert.ok(tryAt < effect.indexOf("sendBeacon"), "sendBeacon runs outside the try block");
    assert.ok(tryAt < effect.indexOf("replaceState"), "replaceState runs outside the try block");
    assert.match(effect, /catch\s*\{/);
  });

  test("it renders nothing and reads the address without useSearchParams", () => {
    // useSearchParams under a static layout needs a Suspense boundary and
    // pulls every page below it into client-side rendering.
    assert.match(code, /return null;/);
    assert.doesNotMatch(code, /useSearchParams/);
  });

  test("it counts with a POST", () => {
    assert.match(code, /sendBeacon\(/);
    assert.match(code, /method: "POST"/);
    assert.doesNotMatch(code, /method: "GET"/);
  });
});
