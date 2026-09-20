/**
 * Short links: `naisi.uk/q/<slug>` answered from a record an admin can repoint.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * The codes this route answers are PRINTED. They were answered by redirects in
 * `next.config.ts` until the route took over, and the whole risk of that swap
 * is a code that used to work and now does not. So the centre of this file is
 * the table below, recorded from production on the night before the swap, and
 * run through the shipping route against a fake database:
 *
 *  1. EVERY PRINTED CODE ANSWERS EXACTLY AS IT DID. Same status, same
 *     `Location`, byte for byte, with no record in the database at all and
 *     with the database refusing to answer. That is the promise that a code
 *     somebody paid to print keeps working.
 *  2. NOTHING CAN SHADOW THE ROUTE. Next matches a redirect before a rewrite
 *     and before the filesystem, so a `/q/<slug>` redirect left in the config
 *     would take over silently: nothing errors, and repointing a code in the
 *     console does nothing. The config is read and every `/q` entry checked.
 *  3. IT IS NOT AN OPEN REDIRECTOR. A destination comes from the record and
 *     never from the request, and passes `parseDestination` on save and again
 *     on every scan. The refused shapes are written out.
 *  4. THE LOCATION IS RELATIVE AND BUILT BY HAND. Behind the hosting proxy
 *     `req.url` carries an internal host, so a `Location` built from it would
 *     work on a laptop and send every code to a dead address in production.
 *  5. THE GET NEVER COUNTS. Held from both sides: `recordScan` is refused by
 *     `tests/get-handlers-readonly.test.mjs`, and nothing the GET imports may
 *     import the counter.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const codeOf = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * What production answered for each printed code on 20 September 2026, read
 * with `curl -sI`, before the route existed. An entry here is never edited: it
 * is the record of where a piece of paper sends people. Repointing a code is
 * done in the admin console, which changes the database and not this table.
 */
const AS_PRINTED = {
  poster: "/links?q=poster",
  brochure: "/links?q=brochure",
  join: "/links?q=join",
  movie: "/events/W2D1NwTZyNLLYtDQhzGg/calendar?q=movie",
  ig: "https://www.instagram.com/notts.ai.safety/",
};

// ---------------------------------------------------------------------------
// The fake database the shipping route is run against
// ---------------------------------------------------------------------------

const records = new Map();
globalThis.__tlFakeDb = {
  collection(collection) {
    return {
      doc(id) {
        return {
          async get() {
            if (globalThis.__tlReadFails) throw new Error("firestore is down");
            const data = records.get(`${collection}/${id}`);
            return { exists: data !== undefined, id, data: () => data };
          },
        };
      },
    };
  },
};

const STUBS = [
  ["server-only", "export {};"],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() {\n  return globalThis.__tlDbMissing ? undefined : globalThis.__tlFakeDb;\n}",
  ],
];

const { loadTs } = createLoader({ stubs: STUBS });
const { PRINTED_LINKS } = await loadTs("lib/campaign/printedLinks.ts");
const {
  parseDestination,
  redirectLocation,
  fallbackLocation,
  validateNewSlug,
  normalizeTrackedLink,
  TRACKED_LINK_LIMITS,
  RESERVED_SLUGS,
} = await loadTs("lib/firestore/trackedLinks.ts");
const { resolveScan } = await loadTs("lib/campaign/resolveScan.ts");
const { forwardingDocument } = await loadTs("lib/campaign/forwardingDocument.ts");
const route = await loadTs("app/api/q/[slug]/route.ts");

function record(slug, overrides = {}) {
  records.set(`trackedLinks/${slug}`, {
    slug,
    label: "A link",
    destination: "/links",
    type: "qr",
    campaign: "",
    active: true,
    countOffsite: false,
    ...overrides,
  });
}

async function scan(slug) {
  const res = await route.GET(new Request(`https://internal-revision.a.run.app/api/q/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  return { status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control"), res };
}

let silenced;
beforeEach(() => {
  records.clear();
  globalThis.__tlReadFails = false;
  globalThis.__tlDbMissing = false;
  silenced?.();
  silenced = undefined;
});

/** The store logs a failed read. Expected in the tests that cause one. */
function expectLoggedErrors() {
  const original = console.error;
  console.error = () => {};
  silenced = () => {
    console.error = original;
  };
}

// ---------------------------------------------------------------------------
// 1. Every printed code answers exactly as it did
// ---------------------------------------------------------------------------

describe("a printed code keeps working", () => {
  test("the table covers every code that is on paper, and nothing else", () => {
    assert.deepEqual(Object.keys(AS_PRINTED).sort(), PRINTED_LINKS.map((l) => l.slug).sort());
  });

  for (const [slug, location] of Object.entries(AS_PRINTED)) {
    test(`/q/${slug}: with no record in the database, answers as production did`, async () => {
      const got = await scan(slug);
      assert.equal(got.status, 307);
      assert.equal(got.location, location);
    });

    test(`/q/${slug}: with the database down, answers as production did`, async () => {
      expectLoggedErrors();
      globalThis.__tlReadFails = true;
      const got = await scan(slug);
      assert.equal(got.status, 307);
      assert.equal(got.location, location);
    });

    test(`/q/${slug}: with no Admin SDK configured at all, answers as production did`, async () => {
      globalThis.__tlDbMissing = true;
      const got = await scan(slug);
      assert.equal(got.status, 307);
      assert.equal(got.location, location);
    });

    test(`/q/${slug}: once its record is created from the printed list, nothing moves`, async () => {
      // What the console's seeding writes. The day the records appear must be
      // a day on which no code changes where it goes.
      const printed = PRINTED_LINKS.find((l) => l.slug === slug);
      record(slug, { destination: printed.destination, type: printed.type, campaign: printed.campaign });
      const got = await scan(slug);
      assert.equal(got.status, 307);
      assert.equal(got.location, location);
    });
  }

  test("a slug retyped in capitals is the same code", async () => {
    assert.equal((await scan("POSTER")).location, AS_PRINTED.poster);
  });

  test("an unknown slug lands on /links carrying itself, never on a 404", async () => {
    const got = await scan("flyer");
    assert.equal(got.status, 307);
    assert.equal(got.location, "/links?q=flyer");
  });

  test("something that is not a slug lands on /links", async () => {
    for (const bad of ["a_b", "way-too-long-to-be-a-slug", "%2e%2e", "a b"]) {
      const got = await scan(bad);
      assert.equal(got.status, 307, `${bad} answered ${got.status}`);
      assert.equal(got.location, "/links");
    }
  });

  test("never a permanent redirect, and never cacheable", async () => {
    // A 308 is cached by the phone for good: that phone could never be sent
    // anywhere else, which is the one property a short link exists for.
    for (const slug of [...Object.keys(AS_PRINTED), "flyer", "a_b"]) {
      const got = await scan(slug);
      assert.equal(got.status, 307);
      assert.equal(got.cache, "no-store");
    }
  });
});

// ---------------------------------------------------------------------------
// The record wins, which is the point of the swap
// ---------------------------------------------------------------------------

describe("a record decides where a code goes", () => {
  test("repointing a printed code works, and the slug still rides along", async () => {
    record("poster", { destination: "/events" });
    assert.equal((await scan("poster")).location, "/events?q=poster");
  });

  test("an existing query string and hash on the destination are kept", async () => {
    record("poster", { destination: "/courses?tab=open#apply" });
    assert.equal((await scan("poster")).location, "/courses?tab=open&q=poster#apply");
  });

  test("a new link that was never printed is answered from its record", async () => {
    record("flyer", { destination: "/resources", type: "link" });
    assert.equal((await scan("flyer")).location, "/resources?q=flyer");
  });

  test("another site is a plain redirect, exactly as typed, with nothing appended", async () => {
    record("su", { destination: "https://su.nottingham.ac.uk/societies/society/naisi/" });
    const got = await scan("su");
    assert.equal(got.status, 307);
    assert.equal(got.location, "https://su.nottingham.ac.uk/societies/society/naisi/");
  });

  test("switched off, a code lands on /links and the printed list does not undo that", async () => {
    // Switching a code off is a decision. The fallback is for damage.
    record("movie", { active: false });
    assert.equal((await scan("movie")).location, "/links?q=movie");
  });

  test("a record whose destination fails validation falls back to where the code was printed to go", async () => {
    // Typed into the Firestore console by hand, or stored before a rule existed.
    for (const bad of ["javascript:alert(1)", "//evil.example", "http://plain.example/", ""]) {
      record("movie", { destination: bad });
      assert.equal((await scan("movie")).location, AS_PRINTED.movie, `followed ${JSON.stringify(bad)}`);
    }
  });

  test("a record with a bad destination that was never printed lands on /links", async () => {
    record("flyer", { destination: "javascript:alert(1)" });
    assert.equal((await scan("flyer")).location, "/links?q=flyer");
  });

  test("a record that lost its `active` field is still live", () => {
    // Missing must never read as switched off: that would kill a printed code.
    assert.equal(normalizeTrackedLink("poster", { destination: "/links" }).active, true);
    assert.equal(normalizeTrackedLink("poster", { active: false }).active, false);
  });

  test("through a database blip, a repointed code keeps going where it was last sent", async () => {
    // Not back to where it went on print day: that event may be over.
    record("join", { destination: "/courses" });
    assert.equal((await scan("join")).location, "/courses?q=join");
    expectLoggedErrors();
    globalThis.__tlReadFails = true;
    assert.equal((await scan("join")).location, "/courses?q=join");
  });
});

describe("resolveScan, branch by branch", () => {
  const link = (overrides) => normalizeTrackedLink("poster", { destination: "/links", ...overrides });

  test("says which step answered", () => {
    assert.equal(resolveScan("poster", { state: "found", link: link({}) }).via, "record");
    assert.equal(resolveScan("poster", { state: "unavailable", lastKnown: link({}) }).via, "last-known");
    assert.equal(resolveScan("poster", { state: "unavailable", lastKnown: null }).via, "printed");
    assert.equal(resolveScan("poster", { state: "missing" }).via, "printed");
    assert.equal(resolveScan("flyer", { state: "missing" }).via, "fallback");
  });

  test("the counting page is only ever for another site, and only when switched on", () => {
    const offsite = { destination: "https://www.instagram.com/notts.ai.safety/" };
    assert.equal(resolveScan("x", { state: "found", link: link(offsite) }).hop, false);
    assert.equal(resolveScan("x", { state: "found", link: link({ ...offsite, countOffsite: true }) }).hop, true);
    assert.equal(resolveScan("x", { state: "found", link: link({ countOffsite: true }) }).hop, false);
  });

  test("no printed code uses the counting page", () => {
    // A forward made by a script is not always handed to the destination's
    // app. Nobody gambles a code that is already on paper on that.
    for (const { slug } of PRINTED_LINKS) {
      assert.equal(resolveScan(slug, { state: "missing" }).hop, false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Nothing can shadow the route
// ---------------------------------------------------------------------------

describe("next.config.ts", () => {
  const config = codeOf("next.config.ts");

  test("the rewrite that exposes the route is there", () => {
    assert.match(config, /source: "\/q\/:slug",\s*destination: "\/api\/q\/:slug"/);
  });

  test("no redirect can match /q/<slug>", () => {
    const redirects = config.slice(config.indexOf("async redirects()"), config.indexOf("async rewrites()"));
    const sources = [...redirects.matchAll(/source:\s*"(\/q[^"]*)"/g)].map((m) => m[1]);
    // The bare prefix, and two segments or more. Neither can match one slug.
    assert.deepEqual(
      sources.sort(),
      ["/q", "/q/:slug/:rest+"],
      "A redirect under /q is matched before the rewrite and before the route, so it silently " +
        "takes over: nothing errors, and repointing a code in the admin console does nothing. " +
        "Give the slug a record in the console instead.",
    );
  });

  test("the route the rewrite points at exists, under src/app/api", () => {
    assert.match(read("src/app/api/q/[slug]/route.ts"), /export async function GET\(/);
  });
});

describe("crawlers are kept off the short links", () => {
  test("robots.txt disallows /q/", () => {
    // A crawler that runs JavaScript would follow a short link, land on the
    // page it points at and fire the scan counter. A link posted anywhere
    // public would then collect scans nobody made.
    assert.match(codeOf("src/app/robots.ts"), /disallow: \[[^\]]*"\/q\/"/);
  });

  test("and the sitemap never lists one", () => {
    assert.doesNotMatch(codeOf("src/app/sitemap.ts"), /["'`]\/q\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. Not an open redirector
// ---------------------------------------------------------------------------

describe("what a destination may be", () => {
  const OWN = ["https://naisi.uk"];

  const REFUSED = [
    ["", "empty"],
    ["   ", "blank"],
    ["//evil.example", "protocol-relative: another site dressed as a path"],
    ["//evil.example/links", "protocol-relative with a path"],
    ["/\\evil.example", "a backslash some browsers read as a slash"],
    ["\\\\evil.example", "backslashes"],
    ["javascript:alert(1)", "a script"],
    ["JaVaScRiPt:alert(1)", "a script, mixed case"],
    ["data:text/html,<script>alert(1)</script>", "a data URL"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["http://example.com/", "plain http"],
    ["ftp://example.com/", "another scheme"],
    ["https://naisi.uk@evil.example/", "a host hidden behind a name"],
    ["https://user:pass@example.com/", "credentials in the address"],
    ["https://localhost/", "no dot in the host"],
    ["/links page", "a space"],
    ["/links\n/evil", "a newline"],
    ["/li\tnks", "a tab inside"],
    ["/q/other", "another short link: a loop"],
    ["/q", "the short link prefix"],
    ["/api/q/poster/scan", "an API route"],
    ["links", "no leading slash and no scheme"],
    ["example.com", "a bare host"],
    [`/${"x".repeat(500)}`, "too long"],
  ];
  for (const [input, why] of REFUSED) {
    test(`refused: ${why}`, () => {
      const parsed = parseDestination(input, OWN);
      assert.equal(parsed.ok, false, `${JSON.stringify(input)} was accepted as ${JSON.stringify(parsed)}`);
      assert.ok(parsed.error.length > 10, "a refusal says why, in words an admin can act on");
    });
  }

  test("a page on this site is kept as the path it names", () => {
    assert.deepEqual(parseDestination("/links", OWN), { ok: true, kind: "internal", value: "/links" });
    assert.deepEqual(parseDestination("  /events/abc/calendar?x=1#top ", OWN), {
      ok: true,
      kind: "internal",
      value: "/events/abc/calendar?x=1#top",
    });
  });

  test("a full address on this site is stored as its path, so it means the same on dev", () => {
    assert.deepEqual(parseDestination("https://naisi.uk/courses?tab=open", OWN), {
      ok: true,
      kind: "internal",
      value: "/courses?tab=open",
    });
    // ...and cannot be used to smuggle a short link past the loop check.
    assert.equal(parseDestination("https://naisi.uk/q/other", OWN).ok, false);
  });

  test("this site is recognised whatever scheme a local server runs on", () => {
    assert.deepEqual(parseDestination("http://localhost:3000/links", ["http://localhost:3000"]), {
      ok: true,
      kind: "internal",
      value: "/links",
    });
    // A name before the host does not make another site this one.
    assert.equal(parseDestination("https://naisi.uk@evil.example/", OWN).ok, false);
    assert.deepEqual(parseDestination("https://someone@naisi.uk/links", OWN), {
      ok: true,
      kind: "internal",
      value: "/links",
    });
  });

  test("another site has to be https, and is kept exactly", () => {
    assert.deepEqual(parseDestination("https://www.instagram.com/notts.ai.safety/", OWN), {
      ok: true,
      kind: "external",
      value: "https://www.instagram.com/notts.ai.safety/",
    });
  });

  test("path tricks cannot leave the site", () => {
    for (const input of ["/../../evil", "/./links", "/%2e%2e/links"]) {
      const parsed = parseDestination(input, OWN);
      if (parsed.ok) {
        assert.equal(parsed.kind, "internal");
        assert.ok(parsed.value.startsWith("/") && !parsed.value.startsWith("//"), parsed.value);
      }
    }
  });

  test("every destination in the printed list passes", () => {
    for (const { slug, destination } of PRINTED_LINKS) {
      assert.equal(parseDestination(destination, OWN).ok, true, `${slug}: ${destination}`);
    }
  });

  test("the slug is added to a page on this site and to nothing else", () => {
    assert.equal(redirectLocation(parseDestination("/links"), "poster"), "/links?q=poster");
    assert.equal(redirectLocation(parseDestination("/links?q=old"), "poster"), "/links?q=poster");
    assert.equal(
      redirectLocation(parseDestination("https://example.com/a?b=1"), "poster"),
      "https://example.com/a?b=1",
    );
    assert.equal(fallbackLocation("flyer"), "/links?q=flyer");
  });
});

describe("the route takes nothing from the request but the slug", () => {
  const code = codeOf("src/app/api/q/[slug]/route.ts");

  test("no query string, no body, no header is read", () => {
    // A `?to=` would make naisi.uk/q/... a way to bounce somebody anywhere
    // under a university society's name.
    assert.doesNotMatch(code, /searchParams|nextUrl|\.url\b|headers\s*\.\s*get\(|\.json\(\)|\.text\(\)|formData/);
    assert.match(code, /_req: Request/, "the request is deliberately unused");
  });
});

// ---------------------------------------------------------------------------
// 4. The Location is relative, and built by hand
// ---------------------------------------------------------------------------

describe("the Location header", () => {
  test("for a page on this site it is a path, whatever host the request arrived on", async () => {
    // `scan()` sends the request in on an internal revision host, as the
    // hosting proxy does. None of that host may reach the Location.
    for (const slug of ["poster", "movie", "flyer", "a_b"]) {
      const { location } = await scan(slug);
      assert.ok(location.startsWith("/") && !location.startsWith("//"), `${slug}: ${location}`);
      assert.doesNotMatch(location, /run\.app|internal-revision/);
    }
  });

  test("the route never builds a redirect from the request", () => {
    const code = codeOf("src/app/api/q/[slug]/route.ts");
    assert.doesNotMatch(code, /NextResponse/, "NextResponse.redirect needs an absolute URL, and the only one to hand is the request's");
    assert.doesNotMatch(code, /new URL\([^)]*req/);
    assert.match(code, /Location: location/);
  });
});

// ---------------------------------------------------------------------------
// 5. The GET never counts
// ---------------------------------------------------------------------------

const FIRESTORE_WRITE = [
  /\b(?:ref|batch|[A-Za-z]\w*Ref)\.(?:set|update|delete|add|create|commit)\(/,
  /\.doc\([^)]*\)\.(?:set|update|delete|create)\(/,
  /\.collection\([^)]*\)\.add\(/,
  /\b(?:tx|transaction|trx)\.(?:set|update|delete|create)\(/,
];

describe("answering a scan writes nothing", () => {
  const READ_PATH = [
    "src/app/api/q/[slug]/route.ts",
    "src/lib/campaign/trackedLinkStore.ts",
    "src/lib/campaign/resolveScan.ts",
    "src/lib/campaign/forwardingDocument.ts",
    "src/lib/campaign/printedLinks.ts",
    "src/lib/firestore/trackedLinks.ts",
  ];
  for (const path of READ_PATH) {
    test(`${path} does not reach the counter or write to the database`, () => {
      const code = codeOf(path);
      assert.doesNotMatch(code, /scanCounter|recordScan/);
      // Keyed on the receiver, as the GET guard is: an in-memory Map.set or a
      // URLSearchParams.set is not a write to the database.
      for (const write of FIRESTORE_WRITE) assert.doesNotMatch(code, write);
      assert.doesNotMatch(code, /FieldValue/);
    });
  }

  test("the route exports GET and nothing else", () => {
    const code = codeOf("src/app/api/q/[slug]/route.ts");
    const methods = [...code.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)].map((m) => m[1]);
    assert.deepEqual(methods, ["GET"]);
  });

  test("the last-good map only ever holds records that exist", () => {
    // A flood of made-up slugs must not be able to grow it.
    const store = codeOf("src/lib/campaign/trackedLinkStore.ts");
    const sets = [...store.matchAll(/lastGood\.set\(/g)].length;
    assert.equal(sets, 1);
    assert.ok(store.indexOf("if (!snap.exists)") < store.indexOf("lastGood.set("));
  });
});

// ---------------------------------------------------------------------------
// The counting page for another site
// ---------------------------------------------------------------------------

describe("the counting page", () => {
  test("a link set to count visits to another site gets the page, and it forwards three ways", async () => {
    record("bio", { destination: "https://www.instagram.com/notts.ai.safety/", countOffsite: true, type: "link" });
    const { res } = await scan("bio");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    const IG = "https://www.instagram.com/notts.ai.safety/";
    for (const expected of [
      'navigator.sendBeacon("/api/q/bio/scan")',
      `location.replace("${IG}")`,
      `<meta http-equiv="refresh" content="2;url=${IG}">`,
      `<a href="${IG}"`,
      "noindex",
    ]) {
      assert.ok(html.includes(expected), `the counting page is missing: ${expected}`);
    }
  });

  test("whatever reaches it is escaped for the markup it lands in", () => {
    // Every spelling a browser accepts, not only the lower-case one: a tag
    // name is case-insensitive and may carry whitespace before its `>`.
    const hostile = `https://example.com/"><script>alert(1)</script><SCRIPT>alert(2)</SCRIPT >?a='&b=</ScRiPt>`;
    const html = forwardingDocument({ destination: hostile, scanPath: `/api/q/x/scan"</script><SCRIPT>` });
    const lower = html.toLowerCase();
    const count = (needle) => lower.split(needle).length - 1;
    assert.equal(count("<script"), 1, "a second script element was opened");
    assert.equal(count("</script"), 1, "the script element was closed early");
    assert.equal(lower.includes('"><'), false, "an attribute was closed and a tag opened after it");
    // The one script element is the document's own, and it is the last thing in the body.
    assert.ok(lower.indexOf("<script") > lower.indexOf("<body"));
  });

  test("it fetches nothing else, so it forwards as soon as the HTML arrives", () => {
    const html = forwardingDocument({ destination: "https://example.com/", scanPath: "/api/q/x/scan" });
    assert.doesNotMatch(html, /<link\b|<img\b|src=|@import|url\(/);
  });
});

// ---------------------------------------------------------------------------
// Minting a new slug, and the limits the rules repeat
// ---------------------------------------------------------------------------

describe("a new slug", () => {
  test("has to be short, lowercase and cleanly hyphenated", () => {
    for (const good of ["flyer", "a", "open-day-26", "x1"]) assert.equal(validateNewSlug(good), null, good);
    for (const bad of ["", "Flyer", "a_b", "-a", "a-", "a--b", "a b", "way-too-long-to-be-a-slug"]) {
      assert.equal(typeof validateNewSlug(bad), "string", `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("cannot be a word that reads as part of the site", () => {
    for (const word of RESERVED_SLUGS) assert.equal(typeof validateNewSlug(word), "string", word);
    assert.ok(RESERVED_SLUGS.includes("links") && RESERVED_SLUGS.includes("q"));
  });

  test("creating one can never write over a slug that is taken", () => {
    // Overwriting would silently repoint somebody else's printed code.
    const mutations = codeOf("src/features/admin/links/trackedLinkMutations.ts");
    const create = mutations.slice(
      mutations.indexOf("export async function createTrackedLink"),
      mutations.indexOf("export async function updateTrackedLink"),
    );
    assert.match(create, /runTransaction\(/);
    assert.match(create, /existing\.exists\(\)\) throw/);
    const seed = mutations.slice(mutations.indexOf("export async function ensurePrintedLinks"));
    assert.match(seed, /runTransaction\(/);
    assert.match(seed, /existing\.exists\(\)\) return false/);
    assert.doesNotMatch(mutations, /deleteDoc/, "a link is switched off, never deleted");
  });

  test("firestore.rules repeats the same limits, and allows no delete", () => {
    const rules = read("firestore.rules");
    const block = rules.slice(rules.indexOf("match /trackedLinks/{slug}"));
    const body = block.slice(0, block.indexOf("\n    }\n") + 1);
    assert.match(body, new RegExp(`\\{1,${TRACKED_LINK_LIMITS.slug}\\}`));
    assert.match(body, new RegExp(`d\\.label\\.size\\(\\) <= ${TRACKED_LINK_LIMITS.label}\\b`));
    assert.match(body, new RegExp(`d\\.campaign\\.size\\(\\) <= ${TRACKED_LINK_LIMITS.campaign}\\b`));
    assert.match(body, new RegExp(`d\\.destination\\.size\\(\\) <= ${TRACKED_LINK_LIMITS.destination}\\b`));
    assert.match(body, /allow delete: if false;/);
  });
});
