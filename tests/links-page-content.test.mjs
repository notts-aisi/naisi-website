/**
 * What the public /links page says, when that is editable from the admin
 * console.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * /links is where most printed QR codes land. Making it editable adds two ways
 * for it to go wrong that a static file never had, and this file holds both:
 *
 *  1. IT NEVER RENDERS EMPTY OR BROKEN. Whatever is stored (nothing, garbage,
 *     every row hidden, a database that does not answer), the page shows the
 *     built-in rows from `src/content/links.ts`. The shipping fetcher is run
 *     against each of those.
 *  2. A STORED ADDRESS IS NOT TRUSTED FOR BEING STORED. Every address passes
 *     `parseDestination()` on save and again on read, so a value typed into
 *     the Firestore console by hand never becomes an anchor on a page
 *     strangers open. And what reaches the page is a projection: no hidden
 *     rows, no editor's uid.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const codeOf = (path) =>
  readFileSync(join(REPO_ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

let stored;
globalThis.__lpFakeDb = {
  doc() {
    return {
      async get() {
        if (globalThis.__lpReadFails) throw new Error("firestore is down");
        if (globalThis.__lpReadHangs) return new Promise(() => {});
        return { exists: stored !== undefined, data: () => stored };
      },
    };
  },
};

const { loadTs } = createLoader({
  stubs: [
    ["server-only", "export {};"],
    [
      "@/lib/firebase/admin",
      "export function getAdminDb() {\n  return globalThis.__lpDbMissing ? undefined : globalThis.__lpFakeDb;\n}",
    ],
  ],
});
const { defaultLinksPage, normalizeLinksPage, publicLinksPage, linksPageErrors, linksPageHrefError, LINKS_PAGE_LIMITS } =
  await loadTs("lib/firestore/linksPage.ts");
const { LINK_GROUPS } = await loadTs("content/links.ts");
const { fetchLinksPage } = await loadTs("features/links/fetchLinksPage.ts");

const row = (overrides = {}) => ({
  id: "r1",
  label: "Our courses",
  sub: "See what is running.",
  href: "/courses",
  soon: false,
  hidden: false,
  ...overrides,
});
const page = (rows, applications = {}) => ({
  applications: {
    fellowship: { open: false, href: "" },
    facilitator: { open: false, href: "" },
    incubator: { open: false, href: "" },
    ...applications,
  },
  groups: [{ id: "g1", heading: "Get involved", rows }],
  updatedByUid: "admin1",
  updatedAt: new Date(),
});

const BUILT_IN = publicLinksPage(defaultLinksPage());

beforeEach(() => {
  stored = undefined;
  globalThis.__lpReadFails = false;
  globalThis.__lpReadHangs = false;
  globalThis.__lpDbMissing = false;
});

async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe("the built-in page", () => {
  test("is the rows in src/content/links.ts, with every application still closed", () => {
    assert.deepEqual(
      BUILT_IN.groups.map((g) => [g.heading, g.rows.map((r) => r.label)]),
      LINK_GROUPS.map((g) => [g.heading, g.rows.map((r) => r.label)]),
    );
    for (const application of Object.values(BUILT_IN.applications)) assert.equal(application.open, false);
  });

  test("passes its own checks", () => {
    assert.deepEqual(linksPageErrors(defaultLinksPage()), []);
  });
});

describe("/links never renders empty or broken", () => {
  test("nothing saved yet: the built-in page", async () => {
    assert.deepEqual(await fetchLinksPage(), BUILT_IN);
  });

  test("no database configured: the built-in page", async () => {
    globalThis.__lpDbMissing = true;
    assert.deepEqual(await fetchLinksPage(), BUILT_IN);
  });

  test("the database refuses to answer: the built-in page", async () => {
    globalThis.__lpReadFails = true;
    assert.deepEqual(await quietly(fetchLinksPage), BUILT_IN);
  });

  for (const [name, doc] of [
    ["not a links page at all", { hello: "world" }],
    ["groups is not a list", { groups: "lots" }],
    ["no sections", { groups: [] }],
    ["a section with no rows", { groups: [{ id: "g", heading: "Empty", rows: [] }] }],
    ["every row hidden", page([row({ hidden: true }), row({ id: "r2", hidden: true })])],
    ["every row pointing nowhere safe", page([row({ href: "javascript:alert(1)" })])],
    ["rows that are not rows", { groups: [{ id: "g", heading: "x", rows: [null, 3, "row", []] }] }],
  ]) {
    test(`${name}: the built-in page`, async () => {
      stored = doc;
      assert.deepEqual(await fetchLinksPage(), BUILT_IN);
    });
  }

  test("a saved page is what is shown", async () => {
    stored = page([row({ label: "Freshers' programme", href: "/events" })]);
    const got = await fetchLinksPage();
    assert.deepEqual(got.groups.map((g) => g.rows.map((r) => [r.label, r.href])), [[["Freshers' programme", "/events"]]]);
  });
});

describe("a stored address is not trusted for being stored", () => {
  const HOSTILE = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example",
    "/\\evil.example",
    "http://plain.example/",
    "https://naisi.uk@evil.example/",
    "",
  ];

  test("a row with an address the site will not follow is left off the page, and the rest stay", async () => {
    stored = page([
      row({ id: "good", label: "Good", href: "/courses" }),
      ...HOSTILE.map((href, i) => row({ id: `bad${i}`, label: `Bad ${i}`, href })),
    ]);
    const got = await fetchLinksPage();
    assert.deepEqual(got.groups[0].rows.map((r) => r.label), ["Good"]);
  });

  test("an application marked open with nowhere safe to go stays a mailing list button", async () => {
    for (const href of HOSTILE) {
      stored = page([row()], { fellowship: { open: true, href } });
      const got = await fetchLinksPage();
      assert.deepEqual(got.applications.fellowship, { open: false, href: "" }, JSON.stringify(href));
    }
  });

  test("an application marked open with a real address becomes a link", async () => {
    stored = page([row()], { fellowship: { open: true, href: " /courses " } });
    assert.deepEqual((await fetchLinksPage()).applications.fellowship, { open: true, href: "/courses" });
  });

  test("a row that only says Opens soon needs no address, and never carries one to the page as a link", async () => {
    stored = page([row({ soon: true, href: "" }), row({ id: "r2", label: "Live", href: "/events" })]);
    const got = await fetchLinksPage();
    assert.deepEqual(got.groups[0].rows.map((r) => [r.label, r.soon]), [["Our courses", true], ["Live", false]]);
  });

  test("what reaches the page carries no hidden row and nothing about who edited it", async () => {
    stored = page([row(), row({ id: "secret", label: "Draft row", hidden: true })]);
    const json = JSON.stringify(await fetchLinksPage());
    assert.doesNotMatch(json, /Draft row|admin1|updatedBy|updatedAt/);
  });

  test("the editor refuses to save what the page would refuse to show", () => {
    assert.equal(typeof linksPageHrefError("javascript:alert(1)", false), "string");
    assert.equal(linksPageHrefError("", true), null);
    assert.equal(typeof linksPageHrefError("", false), "string");
    const bad = normalizeLinksPage(page([row({ href: "//evil.example" })], { incubator: { open: true, href: "" } }));
    assert.equal(linksPageErrors(bad).length, 2);
    assert.deepEqual(linksPageErrors(normalizeLinksPage(page([row()]))), []);
  });
});

describe("a stored page is bounded", () => {
  test("sections and rows past the limits are not read", () => {
    const many = {
      groups: Array.from({ length: 30 }, (_, g) => ({
        id: `g${g}`,
        heading: `Section ${g}`,
        rows: Array.from({ length: 60 }, (_, r) => row({ id: `g${g}r${r}` })),
      })),
    };
    const got = normalizeLinksPage(many);
    assert.equal(got.groups.length, LINKS_PAGE_LIMITS.groups);
    assert.equal(got.groups[0].rows.length, LINKS_PAGE_LIMITS.rowsPerGroup);
  });

  test("text is cut to length, and duplicate ids are made unique so React keys never collide", () => {
    const got = normalizeLinksPage({
      groups: [{ id: "g", heading: "x".repeat(500), rows: [row({ id: "same", label: "y".repeat(500) }), row({ id: "same" })] }],
    });
    assert.equal(got.groups[0].heading.length, LINKS_PAGE_LIMITS.heading);
    assert.equal(got.groups[0].rows[0].label.length, LINKS_PAGE_LIMITS.label);
    assert.notEqual(got.groups[0].rows[0].id, got.groups[0].rows[1].id);
  });
});

describe("the wiring", () => {
  test("the public page reads through the fetcher, never the collection", () => {
    const code = codeOf("src/app/links/page.tsx");
    assert.match(code, /fetchLinksPage\(\)/);
    assert.doesNotMatch(code, /firebase\/firestore|getClientDb|LINK_GROUPS/);
  });

  test("the sign-up component is handed the three buttons' state and nothing else from the page content", () => {
    // Every prop a client component gets from a Server Component is
    // serialised into the public HTML, rendered or not.
    const code = codeOf("src/app/links/page.tsx");
    const tag = code.slice(code.indexOf("<LinksSignup"), code.indexOf(">", code.indexOf("<LinksSignup")) + 1);
    assert.equal(tag.replace(/\s+/g, " "), "<LinksSignup applications={content.applications}>");
  });

  test("an edit shows within a minute", () => {
    assert.match(codeOf("src/app/links/page.tsx"), /export const revalidate = 60;/);
  });

  test("the fetcher gives up on a slow read", () => {
    assert.match(codeOf("src/features/links/fetchLinksPage.ts"), /Promise\.race\(/);
  });
});
