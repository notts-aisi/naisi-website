/**
 * The current privacy policy, the frozen versions behind it, and the
 * re-consent gate that publishing a new one fires.
 *
 * Run with `npm test`.
 *
 * The current version is v4: v3's text plus one sentence, under "When you join
 * the committee", saying what a circulated worksheet records about the person
 * it was sent to. That sentence was first edited straight into v3, which was
 * the wrong move and is the reason §1b below exists. A version the owner has
 * accepted is frozen text. Editing it changes what somebody sees at the
 * archive URL for the wording they agreed to, and it changes it WITHOUT moving
 * CURRENT_POLICY_VERSION, so nobody is ever asked to accept the new sentence.
 * New wording goes in a new file, every time.
 *
 * A policy version is a promise, and the four ways it can quietly become a
 * lie are all pinned here:
 *
 *  1. **The section stops being exhaustive.** v4's "Courses and programmes"
 *     section is the one place the platform tells an applicant what it holds
 *     about them. A later PR that adds a category and forgets the policy has
 *     made the page wrong, so every category the courses hub holds is checked
 *     for by name. These are keyword checks over the rendered copy, which is
 *     coarse on purpose: they cannot judge wording (that is the owner's, see
 *     the OWNER TO CONFIRM block at the top of the file), only that the
 *     subject is addressed at all.
 *  2. **An archived version is edited in place.** Every published version
 *     stays readable at /privacy/v/N, and the only honest way to change a
 *     sentence is a new version. §1b holds EVERY version behind the current
 *     one to a sha256 of its bytes, so any edit to any of them fails here
 *     rather than sitting on an archive page nobody rereads. The digest list
 *     and POLICIES are checked against each other in both directions, which
 *     means publishing v5 cannot happen without freezing v4 in the same
 *     change: that is exactly the moment somebody is meant to stop editing
 *     it. The two phrases from the edit that already happened are pinned
 *     underneath as the named case, because a digest failure only says "this
 *     file changed" and the named case says what changed last time.
 *  3. **A pointer goes on naming last version's file.** Prose in `src` and
 *     `docs` that sends a reader to a version file is how the previous
 *     mistake was invited: a comment saying "keep this in step with v3.tsx"
 *     is an instruction to edit accepted text. §1c walks both trees and fails
 *     any pointer that names a version other than the current one.
 *  4. **The gate stops firing.** Moving CURRENT_POLICY_VERSION is what asks
 *     members to re-accept, and the gate has to be somewhere every authed page
 *     passes through, must not run inside a view-as session, and must still
 *     name a version the site can render.
 *
 * The registry check is the fifth: a version listed in POLICIES with no
 * content component is a 404 or a crash on its archive URL, and the version
 * history page links to every one of them. It runs over every policy in
 * POLICIES, not privacy alone, so a second terms version is covered the day
 * it lands rather than the day somebody remembers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
const V4 = read("src/content/legal/privacy/v4.tsx");
/**
 * v4 with every run of whitespace collapsed to one space. The copy is JSX, so
 * a sentence is wrapped and indented across several lines and no pattern
 * written as a sentence would ever match the raw source. Every content check
 * below runs against this, because v4 is the text the site serves at /privacy.
 */
const V4_FLAT = V4.replace(/\s+/g, " ");
/** v3, read only by §1b, which proves it was left as the owner accepted it. */
const V3 = read("src/content/legal/privacy/v3.tsx");
const V3_FLAT = V3.replace(/\s+/g, " ");
const REGISTRY = read("src/content/legal/registry.tsx");
const AUTHED_LAYOUT = read("src/app/(app)/layout.tsx");

// ---------------------------------------------------------------------------
// §1 The version moved, and every version still renders
// ---------------------------------------------------------------------------

/**
 * A policy key ("privacy") to the prefix its content components carry
 * ("PrivacyContentV3"). Derived rather than listed, so the checks below run
 * over whatever is in POLICIES: naming only privacy here is how the terms
 * side would go unchecked the day it gains a second version.
 */
const componentPrefix = (key) => `${key[0].toUpperCase()}${key.slice(1)}Content`;

/** Every policy key, so no loop below has to name one. */
const POLICY_KEYS = Object.keys(POLICIES);

describe("policy versions", () => {
  test("privacy v4 is current, and the combined version string moved with it", () => {
    assert.equal(currentPolicy("privacy").version, 4);
    assert.equal(CURRENT_POLICY_VERSION, "terms.1+privacy.4");
  });

  test("versions are newest first, which entry [0] depends on", () => {
    for (const key of POLICY_KEYS) {
      const versions = POLICIES[key].versions.map((v) => v.version);
      assert.deepEqual(
        versions,
        [...versions].sort((a, b) => b - a),
        `POLICIES.${key}.versions is not newest first, so currentPolicy("${key}") returns the wrong one`,
      );
    }
  });

  test("every listed version has a content component, so no archive URL is dead", () => {
    // /privacy/versions links every entry in POLICIES and
    // /privacy/v/[version] renders it out of LEGAL_CONTENT. A version listed
    // in one and missing from the other is a broken link on a legal page.
    for (const key of POLICY_KEYS) {
      for (const { version } of POLICIES[key].versions) {
        assert.match(
          REGISTRY,
          new RegExp(`\\b${version}:\\s*${componentPrefix(key)}V${version}\\b`),
          `${key} v${version} is listed in POLICIES but not mapped in registry.tsx`,
        );
        assert.ok(
          existsSync(join(SRC, `content/legal/${key}/v${version}.tsx`)),
          `src/content/legal/${key}/v${version}.tsx is missing`,
        );
      }
    }
  });

  test("every version file on disk is listed in POLICIES", () => {
    // The other direction of the check above. A version file that exists and
    // is not listed has no archive URL and no line on /privacy/versions, so
    // it renders nowhere and reads as a version somebody dropped half way
    // through publishing. Both lists are read off the filesystem and off
    // POLICIES rather than written down here, so adding v5 needs no edit, and
    // it runs per POLICY rather than over privacy alone: a `terms/v2.tsx`
    // dropped in without an entry used to pass this unread.
    for (const key of POLICY_KEYS) {
      const onDisk = readdirSync(join(SRC, "content/legal", key))
        .map((name) => /^v(\d+)\.tsx$/.exec(name))
        .filter(Boolean)
        .map((match) => Number(match[1]))
        .sort((a, b) => b - a);
      const listed = POLICIES[key].versions.map((v) => v.version);
      assert.deepEqual(
        onDisk,
        listed,
        `src/content/legal/${key} holds a different set of versions from ` +
          `POLICIES.${key}.versions. Add the missing entry, or delete the ` +
          "file: a version that is only in one of the two places is either a " +
          "dead file or a dead link on a legal page.",
      );
    }
  });

  test("an archived version is its own file, never a shim over the current one", () => {
    // An archived version must render as it did the day it was published, so
    // no older file may import a newer one to share markup. Derived from
    // POLICIES rather than a written list of v1, v2, v3: a written list stops
    // covering the version it was written before the moment v5 ships.
    for (const key of POLICY_KEYS) {
      const [current, ...archived] = POLICIES[key].versions;
      for (const { version } of archived) {
        const source = read(`src/content/legal/${key}/v${version}.tsx`);
        assert.ok(
          !source.includes(`./v${current.version}`) &&
            !source.includes(`${componentPrefix(key)}V${current.version}`),
          `${key}/v${version}.tsx must not reach into v${current.version}`,
        );
      }
      for (const { version } of POLICIES[key].versions) {
        assert.match(
          read(`src/content/legal/${key}/v${version}.tsx`),
          new RegExp(`export default function ${componentPrefix(key)}`),
          `${key}/v${version}.tsx must export its own content component`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §1b Archived versions are frozen, byte for byte
// ---------------------------------------------------------------------------

/**
 * Every published version that is no longer current, with a sha256 of the file
 * as it is accepted and one line saying whose agreement it records.
 *
 * ## Why a digest and not a list of sentences
 *
 * The failure this closes is "a version the owner accepted was edited in
 * place", and the shape it took was one sentence added to v3 while v3 was
 * live. Pinning that sentence catches that sentence. It does not catch the
 * next one, or a word changed in v1, and the whole point of an archive is
 * that a reader can go back to what they agreed to and find it there. A
 * digest over the file's bytes is the only check that covers every edit,
 * including the ones nobody thought of when this was written.
 *
 * ## Both directions, and what that buys
 *
 * The keys here and the non-current entries in POLICIES are compared as sets.
 * So publishing v5 fails this file until v4's digest is added, and adding a
 * digest for a version that is still current, or for a file that is not
 * there, fails too. That is deliberate: the moment a version stops being
 * current is exactly the moment people stop being asked about changes to it,
 * and it is therefore the moment to nail it down. Freezing it is one command
 * (`shasum -a 256 src/content/legal/<policy>/v<N>.tsx`) at the one point in
 * the process where somebody is already thinking about versions.
 *
 * ## When a digest legitimately changes
 *
 * Almost never, and never for wording. The only honest reasons are changes
 * that cannot alter what the page says (a rename of an imported component, a
 * lint rule reformatting the file). Update the digest in the same commit as
 * that change, say so in the commit message, and check the rendered copy is
 * identical. Anything that changes a word needs a new version instead.
 */
const FROZEN_VERSIONS = new Map([
  [
    "privacy/v1",
    {
      sha256: "70e7ca0d3a43e143f2c8a6ded2d8f73d471de524bbac070c38ab81a7e649ec6d",
      why: "the first privacy policy the site published (25 May 2026); every account created before v2 accepted these exact words and can still read them at /privacy/v/1",
    },
  ],
  [
    "privacy/v2",
    {
      sha256: "3384da6ed2ed18a181cf887bb2f86a142e90da99530a03ca1a2a54e736e81cfc",
      why: "live from 29 June 2026 until v3 replaced it, so it is the wording anyone who joined in that window agreed to",
    },
  ],
  [
    "privacy/v3",
    {
      sha256: "7f0ca1ddc292b15311252c8375483e625df4c70c4ae7fcd23025b38e82464adb",
      why: "the version the owner accepted, and the one the worksheet sentence was edited into in place; this digest is the restored, accepted text and the reason the whole file exists",
    },
  ],
]);

describe("archived versions are frozen", () => {
  const archived = POLICY_KEYS.flatMap((key) =>
    POLICIES[key].versions.slice(1).map(({ version }) => `${key}/v${version}`),
  );

  test("the digest list and POLICIES agree on which versions are archived", () => {
    assert.deepEqual(
      [...FROZEN_VERSIONS.keys()].sort(),
      [...archived].sort(),
      "FROZEN_VERSIONS in this file and POLICIES disagree about which versions " +
        "are behind the current one. Publishing a version freezes the one it " +
        "replaces: run `shasum -a 256 src/content/legal/<policy>/v<N>.tsx`, add " +
        "the entry with one line saying whose agreement that file records, and " +
        "leave the file alone from then on. Removing an entry is only right if " +
        "the version is being unpublished from POLICIES as well.",
    );
  });

  test("each archived file still hashes to the digest recorded here", () => {
    for (const [key, { sha256, why }] of FROZEN_VERSIONS) {
      const file = join(SRC, "content/legal", `${key}.tsx`);
      assert.ok(
        existsSync(file),
        `src/content/legal/${key}.tsx is recorded as frozen but is not on disk. ` +
          "An archived version still renders at its own URL; deleting the file " +
          "breaks that page and the version history that links to it.",
      );
      assert.ok(
        typeof why === "string" && why.length > 30,
        `${key} is frozen with no reason a reader can weigh`,
      );
      assert.equal(
        createHash("sha256").update(readFileSync(file)).digest("hex"),
        sha256,
        `src/content/legal/${key}.tsx has changed since it was frozen. It is a ` +
          "version somebody already accepted, so editing it changes what they " +
          "see at its archive URL WITHOUT moving CURRENT_POLICY_VERSION, which " +
          "means nobody is ever asked about the change. Put the new wording in a " +
          "new version file. If the edit genuinely cannot alter the rendered " +
          "copy (a rename, a reformat), update the digest in the same commit and " +
          "say why there.",
      );
    }
  });
});

/**
 * The named case underneath the digest guard.
 *
 * The worksheet sentence went into v3 first, while v3 was the current version
 * and the owner had already accepted it. Two things were wrong with that, and
 * neither is visible from the page: the archive URL for the wording somebody
 * agreed to now showed a sentence they never saw, and because the version
 * number did not move, the re-consent gate never asked anybody about it. The
 * sentence lives in v4 now.
 *
 * The digest above would already fail if this came back, so these two tests
 * are not the guard. They are the message: a digest mismatch says only "this
 * file changed", and somebody reading that failure for the first time needs
 * to know what changed last time and why it was the wrong move.
 */
describe("v3 is archived, and archived means untouched", () => {
  test("does not carry the worksheet sentence, which belongs to v4", () => {
    assert.ok(
      !/when a worksheet is sent to you/i.test(V3_FLAT),
      "the worksheet sentence is back in v3. v3 is text the owner accepted; " +
        "adding a sentence to it changes what /privacy/v/3 shows without " +
        "moving CURRENT_POLICY_VERSION, so no member is ever asked to accept " +
        "it. Put new wording in a new version file instead.",
    );
    assert.ok(
      !/we never record keystrokes or pasting/i.test(V3_FLAT),
      "v3 must not carry the worksheet promise either: see above.",
    );
  });

  test("still carries its own OWNER TO CONFIRM block", () => {
    // The block is the record of which sentences in v3 state policy rather
    // than describe code. It stays on v3 for as long as v3 renders, because
    // an archived version still has to be readable as the thing the owner
    // was asked to confirm.
    assert.match(V3, /OWNER TO CONFIRM/);
  });
});

// ---------------------------------------------------------------------------
// §1c Pointers name the version that is current
// ---------------------------------------------------------------------------

/**
 * How the edit in §1b was invited, and the check that stops the invitation
 * being reissued.
 *
 * `ApplicationPrivacyNotice.tsx` carried a comment reading "it must stay
 * consistent with the current privacy policy (src/content/legal/privacy/
 * v3.tsx). If one changes, change both." By the time somebody read it, v3 was
 * no longer the one to change, so the comment was an instruction to edit
 * accepted text: the exact move this whole file exists to prevent, written
 * down as house style. `docs/worksheets.md` carried the same pointer, sending
 * the owner to confirm a sentence in the one file that no longer contains it.
 *
 * A pointer like that rots on a schedule nobody controls, so it is checked
 * rather than remembered. Every mention of a version FILE across `src` and
 * `docs` has to name the current version of its policy. Archive URLs
 * (/privacy/v/3) are a different thing and deliberately do not match: those
 * are meant to name an old version, which is what an archive is for.
 *
 * The exemption below is a named list rather than a pattern, so widening it is
 * a decision somebody made in writing.
 */
const POINTER = /(?:src\/)?content\/legal\/([a-z]+)\/v(\d+)(?:\.tsx)?/g;

/** The trees a pointer can hide in: shipping code and the docs that steer it. */
const POINTER_ROOTS = ["src", "docs"];

/** Text this walk can read. Anything else in those trees is not prose. */
const POINTER_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".md"];

const POINTER_EXEMPT = new Map([
  [
    "src/content/legal/registry.tsx",
    "the registry is the one file that MUST name every version, current or not: it maps each to the component that renders its archive URL. Its imports are relative (`./privacy/v1`) and so fall outside the pattern anyway, but the exemption is written down rather than left resting on that accident",
  ],
]);

function textFilesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) textFilesUnder(full, out);
    else if (POINTER_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

describe("pointers to a version file", () => {
  const hits = [];
  for (const root of POINTER_ROOTS) {
    for (const file of textFilesUnder(join(REPO_ROOT, root))) {
      const relative = file.slice(REPO_ROOT.length + 1).split(sep).join("/");
      if (POINTER_EXEMPT.has(relative)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(POINTER)) {
        hits.push({
          relative,
          policy: match[1],
          version: Number(match[2]),
          text: match[0],
        });
      }
    }
  }

  test("the walk found pointers at all, so the check below is not vacuous", () => {
    assert.ok(
      hits.length > 0,
      "no pointer to a policy version file was found anywhere in src or docs. " +
        "Either every one was removed, or the pattern stopped matching the way " +
        "they are written; check the pattern before trusting the green.",
    );
  });

  test("every exemption still exists and carries a reason", () => {
    for (const [file, why] of POINTER_EXEMPT) {
      assert.ok(
        existsSync(join(REPO_ROOT, ...file.split("/"))),
        `${file} is exempt from the pointer check but no longer exists. Drop the entry.`,
      );
      assert.ok(
        typeof why === "string" && why.length > 30,
        `${file} is exempt with no reason a reader can weigh.`,
      );
    }
  });

  test("no pointer in src or docs names a superseded version", () => {
    const stale = hits.filter(
      (hit) =>
        POLICIES[hit.policy] &&
        hit.version !== POLICIES[hit.policy].versions[0].version,
    );
    assert.deepEqual(
      stale.map((hit) => `${hit.relative}: ${hit.text}`),
      [],
      "these pointers send a reader to a version that is no longer current. An " +
        "archived version is text somebody already accepted, so a comment " +
        "telling the next engineer to keep it in step with the product is an " +
        "instruction to change what an archive URL shows without anybody being " +
        "asked. Point them at the current version file instead, and move the " +
        "pointer again the next time a version ships.",
    );
  });

  test("every pointer names a policy that exists", () => {
    const unknown = hits.filter((hit) => !POLICIES[hit.policy]);
    assert.deepEqual(
      unknown.map((hit) => `${hit.relative}: ${hit.text}`),
      [],
      "these pointers name a policy directory that POLICIES does not know " +
        "about, so they lead nowhere. Fix the path, or add the policy.",
    );
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
  ["feedback on the material", /star rating and leave a comment/i],
  ["no anonymous surveys are claimed", /We do not run anonymous surveys on this site/i],
  ["membership tier", /membership tier \(paid, comped, alumni, staff\)/i],
  ["membership provenance", /a list the\s+Students&apos; Union gives us/i],
  ["the conduct flag", /an admin can\s+flag an\s+account and must record a reason/i],
  ["the conduct reason is admin-only", /Reviewers see only that a\s+flag exists, never the reason/i],
  ["certificates are not promised", /We may issue certificates in future/i],
  ["only the two logged downloads are recorded", /Two of those downloads are recorded/],
  ["who can see what", /Who can see what/],
];

describe("the courses section", () => {
  test("exists, is in the table of contents, and is linkable from the apply form", () => {
    assert.match(V4, /id="courses"/);
    assert.match(V4, /\{ id: "courses", label: "Courses and programmes" \}/);
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
        V4_FLAT,
        pattern,
        `privacy v4's courses section no longer names ${what}. The section is ` +
          "the platform's one statement of what it holds about an applicant; " +
          "a category present in the product and absent from the page makes " +
          "the page wrong. Add it back, or remove the feature.",
      );
    });
  }

  test("push subscriptions are named too, outside the courses section", () => {
    assert.match(V4_FLAT, /push subscription from your browser/i);
  });

  test("retention says applications are kept on the account", () => {
    assert.match(V4_FLAT, /Applications are kept against your account/);
  });

  test("retention says what a deletion removes and what it leaves behind", () => {
    // The cascade (`accountDeletion.ts`) removes the account, its
    // applications and reviews, its memberships and its register marks, and
    // deliberately keeps memberRecords, worksheet responses and reviews,
    // tasks, RSVPs, the email log and every Storage object. v3 said deleting
    // the account deleted "all of that" and promised a purge after 30 days
    // that nothing enforces; v4 lists both sides and names no period.
    assert.match(V4_FLAT, /What a deletion removes/);
    assert.match(V4_FLAT, /What a deletion leaves behind/);
    assert.match(V4_FLAT, /scores and notes the reviewers\s+wrote/i);
    assert.match(V4_FLAT, /Nothing in file storage is removed by an account deletion/);
    assert.ok(
      !/30 days/.test(V4_FLAT),
      "v4 must not promise a deletion period: no job enforces one. Build the " +
        "sweep first, then say so.",
    );
    assert.ok(
      !/Deleting your account deletes/.test(V4_FLAT),
      "v4 must not say deleting the account deletes everything about you: " +
        "the cascade keeps memberRecords, worksheet answers, tasks and RSVPs.",
    );
  });

  test("certificates are not described until they exist", () => {
    // No certificates collection, route or page exists anywhere in src. v3
    // described an issued certificate with a public verification page naming
    // the holder and withdrawal on request; v4 says only that we may issue
    // them in future. The day a certificate sweep appears in the cascade,
    // the policy has to describe the feature again.
    assert.ok(
      !/verification page/i.test(V4_FLAT),
      "v4 describes a certificate verification page, and none exists.",
    );
    const cascade = read("src/lib/firestore/accountDeletion.ts");
    assert.ok(
      !/collection\(\s*"certificates"\s*\)/.test(cascade),
      "account deletion now sweeps certificates, so certificates exist and " +
        "the policy must describe them again: what one shows, who can see it, " +
        "and what happens to it on deletion.",
    );
  });

  test("deletion is by email, not a button", () => {
    // POST /api/account/delete answers 409 for any account with a users or
    // collaborators document; an admin runs the cascade. v3 read as though
    // the site did it.
    assert.match(V4_FLAT, /There is no delete button on the site/);
    assert.match(V4_FLAT, /If you decline, you are signed\s+out/);
  });

  test("the export sentence is not upgraded to a promise the code cannot keep", () => {
    // A reviewer's queue already renders the whole applications payload in
    // their browser, so "every export is logged" would be false. The wording
    // is deliberately about what the SITE generates.
    assert.ok(
      !/every export is logged/i.test(V4_FLAT),
      "v4 must not claim every export is logged: copy and paste from a " +
        "reviewer's screen is outside the log by construction.",
    );
  });

  test("the OWNER TO CONFIRM block is gone from v4", () => {
    // The wording of a privacy policy is the owner's. v4 was checked sentence
    // by sentence against the code on 7 September 2026 and its corrections
    // were signed off by the owner in the pull request that landed them, so
    // the block that held the open question is gone. v3 keeps its own list,
    // which §1b checks, because v3 is frozen.
    assert.ok(
      !/OWNER TO CONFIRM/.test(V4),
      "v4 carries an OWNER TO CONFIRM block again: resolve it with the owner " +
        "before merging, then delete it.",
    );
  });

  test("the disclosures the 7 September 2026 check added are all still there", () => {
    // Each of these was something the site did that no earlier version
    // mentioned. A future edit that drops one puts the policy back out of
    // step with the code.
    for (const [name, pattern] of [
      ["email-and-password accounts and the signup record", /create an account with an email address/i],
      ["external collaborator applications", /apply as an external collaborator/i],
      ["the SU membership file as received", /keep the file as we received it/i],
      ["Google reCAPTCHA as a processor", /Google reCAPTCHA/],
      ["reCAPTCHA as the one exception to no tracking cookies", /one exception is Google reCAPTCHA/i],
      ["the session cookie by name", /__session/],
      ["the view-as cookie by name", /__impersonator/],
      ["the last-route local storage key", /naisi\.lastRoute/],
      ["view as, as a processing activity", /open the site as you see it/i],
      ["the worksheet recipient picker's readers", /permission to circulate a worksheet/i],
      ["blind review as a per-round default", /name-blind by default/i],
      ["what other participants see", /any comment or star rating you choose to leave/i],
      ["the push record carries the account", /carries\s+your account so we know where to send/i],
    ]) {
      assert.match(V4_FLAT, pattern, `v4 no longer says: ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// §2b The committee tooling passage
// ---------------------------------------------------------------------------

/**
 * The courses section above is about what the platform holds on an APPLICANT
 * or a participant. What it holds on a committee member (tasks, comments,
 * attachments, and now worksheet activity) is a different passage under "Data
 * we collect", and the tests for it belong here rather than filed under
 * courses.
 */
describe("the committee tooling passage", () => {
  test("worksheet activity tracking is named, with the limit it promises", () => {
    // WORKSHEETS (docs/worksheets.md). A circulated worksheet stamps when the
    // recipient first opened it, counts moves between pages (one running
    // total, not per page), records when they were last active, and
    // accumulates active time in half-minute samples; the sender, the
    // author, the reviewers and admins see the figures. Measuring how long
    // somebody spent on a page is the item on this page a member is least
    // likely to guess at, so the sentence has to survive: both the half that
    // says what is recorded and the half that says what never is.
    assert.match(V4_FLAT, /how many times you moved between its pages/i);
    assert.match(V4_FLAT, /sampled in half-minute steps/i);
    assert.match(V4_FLAT, /We do not record which page you were on, what you typed, or when you pasted/i);
    assert.ok(
      !/how many times you opened each page/i.test(V4_FLAT),
      "v4 claims a per-page open count again; the code keeps one running total.",
    );
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

// ---------------------------------------------------------------------------
// §4 The access-requirements read log: the promise, and the guard on it
// ---------------------------------------------------------------------------

/**
 * v4 tells an applicant, twice, that their access-requirements answer is
 * stored apart, is never scored, and that "every time one of them does we
 * record who read it". The in-form notice says the same thing on the page
 * where the answer is typed.
 *
 * No STAFF route reads that collection yet: the reveal lands in PR33, and the
 * `access-requirements-read` audit kind is sitting in `CourseAuditKind`
 * waiting for it. So the sentence is a promise about code that does not
 * exist, which is exactly the shape of claim a policy quietly breaks.
 *
 * This guard is what keeps it honest. It walks EVERY route file under
 * src/app/api and refuses one that reaches `admissionApplicationPrivate` (by
 * collection name, through the shared id helper, or through the apply tree's
 * shared context module, which addresses the collection on a route's behalf)
 * without also naming the audit kind. A reveal route that forgets the log
 * cannot ship, so the two always land together and the policy stays true the
 * day the feature does.
 *
 * A route that only DELETES these rows should go through
 * `accountDeletion.ts` rather than naming the collection itself, which is
 * what the account-deletion cascade already does.
 *
 * ## The owner lane, and why it is exempt
 *
 * The promise the policy makes is about somebody ELSE reading the answer:
 * "only the person making the final decision and site admins can open it, and
 * every time one of them does we record who read it". The applicant's own
 * apply routes read the row back to put the applicant's own words in their own
 * textarea, which is not a disclosure to anybody and is not what the sentence
 * is about. Logging it would also drown the real audit: a two-minute autosave
 * writes and reads the row on every cycle, so one applicant writing an essay
 * would generate more rows than the whole decision week.
 *
 * The exemption is therefore a NAMED LIST, not a pattern. Each entry is a
 * route that may address the collection only in the owner's own lane, and
 * adding one is a decision somebody made rather than a wildcard a later route
 * slides through. Every entry is checked to still exist, so a rename shows up
 * here rather than silently widening the allowance.
 *
 * ## What "the owner's own lane" rests on, and the one thing that breaks it
 *
 * The whole exemption is the claim that the session the route reads from IS
 * the person whose answer it is. Admin "view as" is the one mechanism on this
 * site that makes that claim false: it swaps the `__session` cookie for the
 * TARGET's, so `getCurrentUser()` returns the member and the doc id the route
 * builds is the member's. Without a guard the owner lane would hand an admin
 * somebody's disability and health information with nothing recording the
 * read, and the exemption would be laundering exactly the disclosure the
 * policy sentence is about.
 *
 * So every entry below calls `assertNotImpersonating()` before it touches the
 * collection, and the test after this list checks that rather than trusting
 * the prose. The server-rendered `/apply/[roundId]` page is the same lane
 * without a route handler in it, and it answers the same question its own way:
 * it checks the marker and omits the private join, which is pinned in
 * `tests/admissions-apply-flow.test.mjs`.
 */
function routeFilesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFilesUnder(full, out);
    else if (/^route\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const REACHES_PRIVATE =
  /["'`]admissionApplicationPrivate["'`]|admissionApplicationPrivateId\b|admissions\/applyContext/;
const NAMES_AUDIT_KIND = /access-requirements-read/;

/**
 * Routes that may reach the collection WITHOUT a log, because they only ever
 * read the caller's own answer back to the caller. See the section comment.
 */
const OWNER_LANE = [
  [
    "src/app/api/admissions/rounds/[roundId]/apply/route.ts",
    "reads and writes the applicant's own access-requirements answer, addressed by their own uid, and shows it back to them in their own form; every handler including the GET refuses while a view-as session is live, so the session it reads from is always really the owner's",
  ],
  [
    "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts",
    "re-reads the caller's own row after committing the submission, to answer with their own application, and refuses during a view-as session",
  ],
  [
    "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts",
    "same, for one later-released stage, and refuses during a view-as session",
  ],
];

const OWNER_LANE_PATHS = new Set(OWNER_LANE.map(([file]) => file));

describe("the access-requirements read log", () => {
  const routes = routeFilesUnder(join(SRC, "app/api"));

  test("the walk found routes at all, so the guard below is not vacuous", () => {
    assert.ok(
      routes.length > 20,
      `only ${routes.length} route files found under src/app/api; the walk is broken`,
    );
  });

  test("the audit kind the policy promises exists in the enum", () => {
    const audit = read("src/lib/firestore/courseAudit.ts");
    assert.match(audit, NAMES_AUDIT_KIND);
  });

  test("every owner-lane exemption still exists and carries a reason", () => {
    for (const [file, reason] of OWNER_LANE) {
      assert.ok(
        existsSync(join(REPO_ROOT, ...file.split("/"))),
        `${file} is exempt from the access-requirements read log but no longer exists. Drop the entry.`,
      );
      assert.ok(
        typeof reason === "string" && reason.length > 20,
        `${file} is exempt with no reason a reader can weigh.`,
      );
    }
  });

  test("every owner-lane handler refuses a view-as session, reads included", () => {
    // The exemption's whole premise is that the session is the owner's. A
    // view-as session makes that false, so a handler in this lane that did not
    // guard would be an unlogged disclosure of the one answer the policy
    // singles out. READS are included deliberately: the private join is a
    // read, and it is the disclosure.
    for (const [file] of OWNER_LANE) {
      const src = readFileSync(join(REPO_ROOT, ...file.split("/")), "utf8");
      const handlers = [...src.matchAll(/export\s+async\s+function\s+([A-Z]+)\s*\(/g)];
      assert.ok(handlers.length > 0, `${file} exports no handlers the scan can see`);
      for (const match of handlers) {
        const window = src.slice(match.index, match.index + 500);
        assert.match(
          window,
          /assertNotImpersonating\(\)/,
          `${file} ${match[1]} is in the owner lane but does not refuse a view-as session at the top of the handler`,
        );
      }
    }
  });

  test("no route reaches admissionApplicationPrivate without logging the read", () => {
    const offenders = routes.filter((file) => {
      const relative = file.slice(REPO_ROOT.length + 1).split(sep).join("/");
      if (OWNER_LANE_PATHS.has(relative)) return false;
      const source = readFileSync(file, "utf8");
      return REACHES_PRIVATE.test(source) && !NAMES_AUDIT_KIND.test(source);
    });
    assert.deepEqual(
      offenders.map((f) => f.slice(REPO_ROOT.length + 1)),
      [],
      "these routes reach the access-requirements collection without naming " +
        "the `access-requirements-read` audit kind. The privacy policy and " +
        "the in-form notice both promise that every read of that answer is " +
        "recorded, so a route that reveals it without appending a courseAudit " +
        "row makes both pages false. Append the row in the same route, or " +
        "take the promise off the policy.",
    );
  });

  test("the promise is on the page and in the in-form notice", () => {
    assert.match(V4_FLAT, /every time one of them does we record who read it/i);
    const notice = read("src/features/admissions/ApplicationPrivacyNotice.tsx");
    assert.match(notice.replace(/\s+/g, " "), /We record each time one of them/i);
  });
});
