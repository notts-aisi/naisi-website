/**
 * Privacy policy v3 and the re-consent gate that publishing it fires.
 *
 * Run with `npm test`.
 *
 * A policy version is a promise, and the two ways it can quietly become a lie
 * are both pinned here:
 *
 *  1. **The section stops being exhaustive.** v3's "Courses and programmes"
 *     section is the one place the platform tells an applicant what it holds
 *     about them. A later PR that adds a category and forgets the policy has
 *     made the page wrong, so every category the courses hub holds is checked
 *     for by name. These are keyword checks over the rendered copy, which is
 *     coarse on purpose: they cannot judge wording (that is the owner's, see
 *     the OWNER TO CONFIRM block at the top of the file), only that the
 *     subject is addressed at all.
 *  2. **The gate stops firing.** Moving CURRENT_POLICY_VERSION is what asks
 *     members to re-accept, and the gate has to be somewhere every authed page
 *     passes through, must not run inside a view-as session, and must still
 *     name a version the site can render.
 *
 * The registry check is the third: a version listed in POLICIES with no
 * content component is a 404 or a crash on its archive URL, and the version
 * history page links to every one of them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;
const STUBS = new Map([["server-only", "export {};"]]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

async function transpileToDataUrl(file) {
  const cached = graph.get(file);
  if (cached) return cached;
  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });
  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, dataUrl(STUBS.get(specifier)));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }
  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) tsc = (await import("typescript")).default;
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const { CURRENT_POLICY_VERSION, POLICIES, currentPolicy } =
  await loadTs("lib/legal/policies.ts");

const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const V3 = read("src/content/legal/privacy/v3.tsx");
/**
 * v3 with every run of whitespace collapsed to one space. The copy is JSX, so
 * a sentence is wrapped and indented across several lines and no pattern
 * written as a sentence would ever match the raw source. Every content check
 * below runs against this.
 */
const V3_FLAT = V3.replace(/\s+/g, " ");
const REGISTRY = read("src/content/legal/registry.tsx");
const AUTHED_LAYOUT = read("src/app/(app)/layout.tsx");

// ---------------------------------------------------------------------------
// §1 The version moved, and every version still renders
// ---------------------------------------------------------------------------

describe("policy versions", () => {
  test("privacy v3 is current, and the combined version string moved with it", () => {
    assert.equal(currentPolicy("privacy").version, 3);
    assert.equal(CURRENT_POLICY_VERSION, "terms.1+privacy.3");
  });

  test("versions are newest first, which entry [0] depends on", () => {
    const versions = POLICIES.privacy.versions.map((v) => v.version);
    assert.deepEqual(versions, [...versions].sort((a, b) => b - a));
  });

  test("every listed version has a content component, so no archive URL is dead", () => {
    // /privacy/versions links every entry in POLICIES and
    // /privacy/v/[version] renders it out of LEGAL_CONTENT. A version listed
    // in one and missing from the other is a broken link on a legal page.
    for (const { version } of POLICIES.privacy.versions) {
      assert.match(
        REGISTRY,
        new RegExp(`\\b${version}:\\s*PrivacyContentV${version}\\b`),
        `privacy v${version} is listed in POLICIES but not mapped in registry.tsx`,
      );
      assert.ok(
        existsSync(join(SRC, `content/legal/privacy/v${version}.tsx`)),
        `src/content/legal/privacy/v${version}.tsx is missing`,
      );
    }
  });

  test("v1 and v2 are still their own frozen files, not shims over v3", () => {
    // An archived version must render as it did the day it was published, so
    // neither older file may import the newer one to share markup.
    for (const older of ["v1", "v2"]) {
      const source = read(`src/content/legal/privacy/${older}.tsx`);
      assert.ok(
        !source.includes("./v3") && !source.includes("PrivacyContentV3"),
        `${older}.tsx must not reach into v3`,
      );
      assert.match(source, /export default function PrivacyContent/);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 The courses section is exhaustive
// ---------------------------------------------------------------------------

/**
 * Every category the courses hub holds or is about to hold this term, with a
 * phrase that must appear in the section. Sourced from the owner decisions:
 * if a category is dropped from here, it has to be dropped from the product
 * too, not just from the page.
 */
const MUST_NAME = [
  ["application answers", /Everything you type into the application form/i],
  ["drafts", /Drafts are saved on our servers/i],
  ["availability", /availability/i],
  ["access requirements", /access-requirements box|Access requirements/],
  ["access requirements are never scored", /never scored/],
  ["access-requirements reads are recorded", /every time one of them does we record who read it/i],
  ["reviewer scores", /scores your application against/i],
  ["reviewer notes are disclosable", /what a reviewer wrote about your application, we will tell you/i],
  ["attendance registers", /present, arrived late, left early, absent, or\s*\{?"?\s*excused/i],
  ["participant notes", /private note about a named\s+participant/i],
  ["exercise responses", /Answers to exercises/i],
  ["facilitator feedback", /feedback a facilitator writes on your work/i],
  ["weekly feedback and surveys", /Weekly feedback forms/i],
  ["anonymous responses carry no identity", /we store the answers with no link to you/i],
  ["membership tier", /membership tier \(paid, comped, alumni, staff\)/i],
  ["membership provenance", /a list the\s+Students&apos; Union gives us/i],
  ["the conduct flag", /an admin can\s+flag an\s+account and must record a reason/i],
  ["the conduct reason is admin-only", /Reviewers see only that a\s+flag exists, never the reason/i],
  ["certificates", /verification page anyone holding the link can open/i],
  ["the certificate page names the recipient", /That\s+page names you, the programme and the date/i],
  ["downloads are recorded", /Downloads generated by the site are recorded/],
  ["who can see what", /Who can see what/],
];

describe("the courses section", () => {
  test("exists, is in the table of contents, and is linkable from the apply form", () => {
    assert.match(V3, /id="courses"/);
    assert.match(V3, /\{ id: "courses", label: "Courses and programmes" \}/);
    const notice = read("src/features/admissions/ApplicationPrivacyNotice.tsx");
    assert.match(
      notice,
      /COURSES_PRIVACY_HREF = "\/privacy#courses"/,
      "the in-form notice must link to the section anchor",
    );
  });

  for (const [what, pattern] of MUST_NAME) {
    test(`names ${what}`, () => {
      assert.match(
        V3_FLAT,
        pattern,
        `privacy v3's courses section no longer names ${what}. The section is ` +
          "the platform's one statement of what it holds about an applicant; " +
          "a category present in the product and absent from the page makes " +
          "the page wrong. Add it back, or remove the feature.",
      );
    });
  }

  test("push subscriptions are named too, outside the courses section", () => {
    assert.match(V3_FLAT, /push subscription from your browser/i);
  });

  test("retention says applications are kept on the account", () => {
    assert.match(V3_FLAT, /Applications are kept against your account/);
    assert.match(V3_FLAT, /Deleting your account deletes/);
  });

  test("retention does not claim account deletion removes certificates", () => {
    // Two sentences on this page have to agree with each other and with the
    // cascade. The Certificates bullet says a verification page stays online
    // until it is withdrawn on request; `accountDeletion.ts` has no
    // certificate sweep. So the retention paragraph must NOT fold
    // certificates into "deleting your account deletes all of it", and it
    // must say what does happen to the page instead.
    assert.match(V3_FLAT, /Certificates are the exception/);
    assert.match(
      V3_FLAT,
      /A certificate and its verification page are not removed when your account is deleted/,
    );
    const cascade = read("src/lib/firestore/accountDeletion.ts");
    assert.ok(
      !/collection\(\s*"certificates"\s*\)/.test(cascade),
      "account deletion now sweeps certificates, so the policy's carve-out " +
        "is wrong. Change the Retention and Certificates wording in the same " +
        "commit, and take the choice off the OWNER TO CONFIRM list.",
    );
  });

  test("the export sentence is not upgraded to a promise the code cannot keep", () => {
    // A reviewer's queue already renders the whole applications payload in
    // their browser, so "every export is logged" would be false. The wording
    // is deliberately about what the SITE generates.
    assert.ok(
      !/every export is logged/i.test(V3_FLAT),
      "v3 must not claim every export is logged: copy and paste from a " +
        "reviewer's screen is outside the log by construction.",
    );
  });

  test("the OWNER TO CONFIRM block is still at the top of the file", () => {
    // The wording of a privacy policy is the owner's. The block lists the
    // sentences that state policy rather than describe code, and it stays
    // until he has read them.
    assert.match(V3, /OWNER TO CONFIRM/);
  });
});

// ---------------------------------------------------------------------------
// §3 The re-consent gate
// ---------------------------------------------------------------------------

describe("the re-consent gate", () => {
  test("lives on the shared authed layout, so every authed page passes it", () => {
    assert.match(AUTHED_LAYOUT, /CURRENT_POLICY_VERSION/);
    assert.match(AUTHED_LAYOUT, /redirect\("\/re-consent"\)/);
  });

  test("is not left behind on the dashboard layout alone", () => {
    // The old placement asked only members who opened /dashboard, which is
    // less than the policy page promises.
    const dashboardLayout = join(REPO_ROOT, "src/app/(app)/dashboard/layout.tsx");
    if (existsSync(dashboardLayout)) {
      assert.match(
        AUTHED_LAYOUT,
        /policyVersion !== CURRENT_POLICY_VERSION/,
        "if a dashboard-level gate is reintroduced, the shared layout must " +
          "still hold one of its own",
      );
    }
  });

  test("keeps the deployed-builds-only condition", () => {
    assert.match(AUTHED_LAYOUT, /process\.env\.NODE_ENV === "production"/);
  });

  test("never fires inside a view-as session", () => {
    // Accepting is recorded on the member's own doc, and view-as records it
    // as the member: an admin could otherwise stamp a consent the member
    // never gave.
    assert.match(AUTHED_LAYOUT, /!viewingAs/);
    const route = read("src/app/api/account/reconsent/route.ts");
    assert.match(route, /assertNotImpersonating\(\)/);
  });
});
