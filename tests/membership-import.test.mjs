/**
 * The SU import's pure half, EXECUTED (run via `npm test`, Node's built-in
 * runner, no dependencies).
 *
 * Five things are worth executing here, and each is a place this design goes
 * quietly wrong rather than loudly:
 *
 *  1. THE PARSER. A CSV that swallows the rest of the file after an unclosed
 *     quote, or silently drops a cell when a name contains a comma, produces a
 *     receipt that looks fine and an import that is not.
 *  2. THE THREE-TIER MATCH. Verified university email, then sign-in email,
 *     then name as CONFIRM-ONLY. If the order slips, a weak match records a
 *     membership nobody proved; if the ambiguity check slips, two people
 *     sharing a name get one another's membership.
 *  3. DE-DUPLICATION INSIDE ONE FILE. An SU export with one row per
 *     transaction lists a renewal twice, and 600 lines producing 598 people
 *     has to be REPORTED rather than left to be noticed.
 *  4. THE COMMIT PLANNER. The rules that make a re-run a no-op and stop an
 *     import overwriting a manual grant live in one pure function, so they
 *     can be stated as cases rather than inferred from a route.
 *  5. THE ACCOUNT-DELETION SWEEP. Rows name people; batches are provenance and
 *     are kept. Executed, because "which of these two things gets deleted" is
 *     not something a source pin can answer.
 *
 * The loader dance is the one from `account-deletion-memberships.test.mjs`:
 * this repo's Node predates native TypeScript stripping, so the module graph
 * is transpiled in memory with the `typescript` devDependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n"
      + "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n"
      + "  arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),\n"
      + "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n"
      + "  increment: (by) => ({ __op: 'increment', by }),\n"
      + "};\n"
      + "export const FieldPath = { documentId: () => '__name__' };\n"
      + "export const Timestamp = { fromDate: (d) => d, now: () => new Date() };",
  ],
]);

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

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
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
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      // The scan is a regex over source text, so a plain string literal can
      // look like an import: `"su-import"` carries the word `import` inside it.
      try {
        rewrites.set(specifier, import.meta.resolve(specifier));
      } catch {
        // Not a module. Leave the source alone.
      }
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
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const imports = await loadTs(join("lib", "firestore", "membershipImports.ts"));
const list = await loadTs(join("features", "admin", "membershipList.ts"));
const { deleteMembershipImportRows } = await loadTs(
  join("lib", "firestore", "accountDeletion.ts"),
);

// ---------------------------------------------------------------------------
// 1. The parser
// ---------------------------------------------------------------------------

test("a plain file parses into a header and trimmed rows", () => {
  const parsed = imports.parseCsv("name,email\nAda Lovelace,ada@example.com\n");
  assert.deepEqual(parsed.header, ["name", "email"]);
  assert.deepEqual(parsed.rows, [["Ada Lovelace", "ada@example.com"]]);
});

test("CRLF, a BOM and a missing final newline all parse the same", () => {
  const expected = [["Ada", "ada@example.com"]];
  for (const source of [
    "name,email\r\nAda,ada@example.com\r\n",
    "﻿name,email\nAda,ada@example.com",
    "name,email\nAda,ada@example.com\n\n",
  ]) {
    const parsed = imports.parseCsv(source);
    assert.deepEqual(parsed.header, ["name", "email"], source);
    assert.deepEqual(parsed.rows, expected, source);
  }
});

test("a quoted comma stays inside its cell, and doubled quotes unescape", () => {
  const parsed = imports.parseCsv('name,note\n"Lovelace, Ada","she said ""hello"""\n');
  assert.deepEqual(parsed.rows, [["Lovelace, Ada", 'she said "hello"']]);
});

test("a newline inside a quoted cell does not end the row", () => {
  const parsed = imports.parseCsv('name,note\n"Ada","line one\nline two"\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0][1], "line one\nline two");
});

test("an unterminated quote is an error naming the line, not a swallowed file", () => {
  const parsed = imports.parseCsv('name,email\n"Ada,ada@example.com\nBob,bob@example.com\n');
  assert.ok("error" in parsed);
  assert.match(parsed.error, /never closed/);
});

test("a row with MORE cells than the header is refused by line number", () => {
  // This is what an unescaped comma in a name looks like. Guessing which cell
  // to drop is how a surname becomes somebody else's email address.
  const parsed = imports.parseCsv("name,email\nLovelace, Ada,ada@example.com\n");
  assert.ok("error" in parsed);
  assert.match(parsed.error, /Line 2/);
});

test("a row with FEWER cells is padded, and a blank line is dropped", () => {
  const parsed = imports.parseCsv("name,email,tier\nAda,ada@example.com\n\nBob\n");
  assert.deepEqual(parsed.rows, [
    ["Ada", "ada@example.com", ""],
    ["Bob", "", ""],
  ]);
});

test("an empty file is refused rather than read as zero people", () => {
  assert.ok("error" in imports.parseCsv(""));
});

// ---------------------------------------------------------------------------
// 2. Columns
// ---------------------------------------------------------------------------

test("the university email column is claimed before the plain email column", () => {
  const columns = imports.resolveColumns(["Name", "Email", "University Email"]);
  assert.equal(columns.name, 0);
  assert.equal(columns.email, 1);
  assert.equal(
    columns.uniEmail,
    2,
    "a file with both columns must not have the proven address read as the "
      + "sign-in one, which would match at the weaker tier",
  );
});

test("a file whose only address column is the student one keeps it as the uni email", () => {
  const columns = imports.resolveColumns(["Student Email", "First name", "Last name"]);
  assert.equal(columns.uniEmail, 0);
  assert.equal(columns.email, -1);
  assert.equal(columns.firstName, 1);
  assert.equal(columns.lastName, 2);
});

test("a file with nothing to match on is refused", () => {
  const columns = imports.resolveColumns(["Membership number", "Paid on"]);
  assert.ok("error" in columns);
});

test("a first and last name column are joined into one name", () => {
  const columns = imports.resolveColumns(["First Name", "Surname"]);
  const candidates = imports.candidatesFrom([["Ada", "Lovelace"]], columns, "paid");
  assert.equal(candidates[0].name, "Ada Lovelace");
  assert.equal(candidates[0].line, 2, "the header is line 1");
});

test("a membership type column picks the tier, and its absence uses the default", () => {
  const columns = imports.resolveColumns(["Name", "Membership type"]);
  const candidates = imports.candidatesFrom(
    [["Ada", "Bursary"], ["Bob", ""], ["Cee", "Alumni"]],
    columns,
    "paid",
  );
  assert.deepEqual(
    candidates.map((c) => c.tier),
    ["comped", "paid", "alumni"],
  );
});

// ---------------------------------------------------------------------------
// 3. Names and addresses
// ---------------------------------------------------------------------------

test("a name key survives case, accents, punctuation, honorifics and word order", () => {
  const key = imports.normaliseName("Ada Lovelace");
  for (const spelling of ["ada lovelace", "ADA  LOVELACE", "Lovelace, Ada", "Dr Ada Lovelace"]) {
    assert.equal(imports.normaliseName(spelling), key, spelling);
  }
  assert.equal(imports.normaliseName("Renée Descartes"), imports.normaliseName("Renee Descartes"));
  assert.equal(imports.normaliseName("   "), "");
});

test("an email key is trimmed and case-folded", () => {
  assert.equal(imports.normaliseEmail("  ADA@Example.COM "), "ada@example.com");
  assert.equal(imports.normaliseEmail(undefined), "");
});

// ---------------------------------------------------------------------------
// 4. The three-tier match
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  {
    uid: "u-ada",
    email: "ada.personal@gmail.com",
    displayName: "Ada Lovelace",
    preferredName: "Ada",
    verifiedUniEmail: "Ada.Lovelace@nottingham.ac.uk",
  },
  {
    uid: "u-bob",
    email: "bob@example.com",
    displayName: "Bob Baker",
    preferredName: "",
    verifiedUniEmail: "",
  },
  {
    uid: "u-twin-1",
    email: "twin1@example.com",
    displayName: "Sam Twin",
    preferredName: "",
    verifiedUniEmail: "",
  },
  {
    uid: "u-twin-2",
    email: "twin2@example.com",
    displayName: "Sam Twin",
    preferredName: "",
    verifiedUniEmail: "",
  },
];

const INDEX = imports.buildMatchIndex(ACCOUNTS);

function candidate(over = {}) {
  return { line: 2, name: "", email: "", uniEmail: "", tier: "paid", ...over };
}

test("a verified university email is the strongest match, whatever its case", () => {
  const match = imports.matchCandidate(
    INDEX,
    candidate({ uniEmail: "ADA.LOVELACE@NOTTINGHAM.AC.UK", name: "Someone Else" }),
  );
  assert.equal(match.kind, "uni-email");
  assert.equal(match.uid, "u-ada");
});

test("a sign-in email matches at the weaker tier", () => {
  const match = imports.matchCandidate(INDEX, candidate({ email: "bob@example.com" }));
  assert.equal(match.kind, "personal-email");
  assert.equal(match.uid, "u-bob");
});

test("a verified address in the WRONG column still matches at the stronger tier", () => {
  // SU exports put the university address in whichever column they feel like.
  const match = imports.matchCandidate(
    INDEX,
    candidate({ email: "ada.lovelace@nottingham.ac.uk" }),
  );
  assert.equal(match.kind, "uni-email");
  assert.equal(match.uid, "u-ada");
});

test("an UNVERIFIED university email is not in the index at all", () => {
  const index = imports.buildMatchIndex([
    {
      uid: "u-x",
      email: "",
      displayName: "",
      preferredName: "",
      // The route only ever puts a VERIFIED address here; an empty string is
      // what an unverified one becomes.
      verifiedUniEmail: "",
    },
  ]);
  const match = imports.matchCandidate(index, candidate({ uniEmail: "x@nottingham.ac.uk" }));
  assert.equal(match.kind, "none");
});

test("a lone name match is CONFIRM-ONLY and never auto-committable", () => {
  const match = imports.matchCandidate(INDEX, candidate({ name: "ada lovelace" }));
  assert.equal(match.kind, "name");
  assert.equal(match.uid, "u-ada");
  assert.equal(imports.isAutoCommittable(match.kind), false);
  assert.equal(imports.matchedOnForKind(match.kind), "name-confirmed");
});

test("a name two accounts answer to is not a match at all", () => {
  const match = imports.matchCandidate(INDEX, candidate({ name: "Sam Twin" }));
  assert.equal(match.kind, "none");
  assert.equal(match.uid, null);
  assert.match(match.note, /2 accounts/);
});

test("a person with no account is unmatched, with the reason written out", () => {
  const match = imports.matchCandidate(
    INDEX,
    candidate({ name: "Nobody Here", email: "nobody@example.com" }),
  );
  assert.equal(match.kind, "none");
  assert.notEqual(match.note, "");
});

// ---------------------------------------------------------------------------
// 5. The plan and the receipt
// ---------------------------------------------------------------------------

test("a second line for the same person is a duplicate, not a second grant", () => {
  const planned = imports.planImportRows(INDEX, [
    candidate({ line: 2, uniEmail: "ada.lovelace@nottingham.ac.uk" }),
    candidate({ line: 3, email: "ada.personal@gmail.com" }),
    candidate({ line: 4, email: "bob@example.com" }),
  ]);
  assert.deepEqual(
    planned.map((row) => row.match.kind),
    ["uni-email", "duplicate", "personal-email"],
  );
  assert.equal(planned[1].match.uid, "u-ada", "a duplicate still says who it was");
});

test("two unmatched lines for the same stranger are also de-duplicated", () => {
  const planned = imports.planImportRows(INDEX, [
    candidate({ line: 2, email: "stranger@example.com" }),
    candidate({ line: 3, email: "STRANGER@example.com" }),
  ]);
  assert.equal(planned[0].match.kind, "none");
  assert.equal(planned[1].match.kind, "duplicate");
});

test("row ids are zero-padded and sort in file order", () => {
  const planned = imports.planImportRows(
    INDEX,
    Array.from({ length: 12 }, (unused, i) => candidate({ line: i + 2, email: `p${i}@x.com` })),
  );
  assert.equal(planned[0].rowId, "0001");
  assert.equal(planned[11].rowId, "0012");
  const sorted = [...planned.map((r) => r.rowId)].sort();
  assert.deepEqual(sorted, planned.map((r) => r.rowId));
});

test("a row sequence must be a positive integer", () => {
  assert.throws(() => imports.membershipImportRowId(0), RangeError);
  assert.throws(() => imports.membershipImportRowId(1.5), RangeError);
});

test("the batch id says which period and which minute, and two in one minute differ", () => {
  const at = new Date("2026-10-09T14:31:59.123Z");
  const a = imports.membershipImportBatchId("2026-27", at);
  const b = imports.membershipImportBatchId("2026-27", at);
  assert.match(a, /^import-2026-27-2026-10-09t14-31__[a-z0-9]{8}$/);
  assert.notEqual(a, b);
});

test("the receipt counts every kind, and only auto-committable rows by tier", () => {
  const planned = imports.planImportRows(INDEX, [
    candidate({ line: 2, uniEmail: "ada.lovelace@nottingham.ac.uk", tier: "paid" }),
    candidate({ line: 3, email: "bob@example.com", tier: "comped" }),
    candidate({ line: 4, name: "Ada Lovelace", tier: "paid" }),
    candidate({ line: 5, email: "bob@example.com", tier: "paid" }),
    candidate({ line: 6, name: "Nobody Here", tier: "paid" }),
  ]);
  const receipt = imports.summariseImport(planned);
  assert.deepEqual(receipt, {
    total: 5,
    uniEmail: 1,
    personalEmail: 1,
    // The name row is Ada again, and Ada is already claimed by line 2, so it
    // is a duplicate before it is a name match.
    needsConfirm: 0,
    duplicate: 2,
    unmatched: 1,
    autoCommittable: 2,
    byTier: { paid: 1, comped: 1, alumni: 0, staff: 0 },
  });
});

// ---------------------------------------------------------------------------
// 6. The commit planner
// ---------------------------------------------------------------------------

function row(over = {}) {
  return {
    rowId: "0001",
    state: "pending",
    matchKind: "uni-email",
    matchedUid: "u-ada",
    tier: "paid",
    ...over,
  };
}

const NOBODY_CONFIRMED = new Set();

test("an email match with no existing membership commits", () => {
  const decision = imports.planCommitRow(row(), null, NOBODY_CONFIRMED);
  assert.deepEqual(decision, {
    action: "commit",
    uid: "u-ada",
    tier: "paid",
    matchedOn: "uni-email",
  });
});

test("a row already committed or skipped is done, which is what makes a re-run a no-op", () => {
  for (const state of ["committed", "skipped"]) {
    assert.deepEqual(
      imports.planCommitRow(row({ state }), null, NOBODY_CONFIRMED),
      { action: "done" },
    );
  }
});

test("a name row is refused until its id is confirmed, and stays PENDING", () => {
  const refused = imports.planCommitRow(
    row({ matchKind: "name" }),
    null,
    NOBODY_CONFIRMED,
  );
  assert.equal(
    refused.action,
    "await-confirm",
    "skipping it would stamp the row and make a later confirmation useless",
  );
  const confirmed = imports.planCommitRow(
    row({ matchKind: "name" }),
    null,
    new Set(["0001"]),
  );
  assert.deepEqual(confirmed, {
    action: "commit",
    uid: "u-ada",
    tier: "paid",
    matchedOn: "name-confirmed",
  });
});

test("a confirmation for ANOTHER row does not release this one", () => {
  const decision = imports.planCommitRow(
    row({ rowId: "0007", matchKind: "name" }),
    null,
    new Set(["0001", "0002"]),
  );
  assert.equal(decision.action, "await-confirm");
});

test("an existing membership from the same import at the same tier is a no-op", () => {
  const decision = imports.planCommitRow(
    row(),
    { tier: "paid", source: "su-import" },
    NOBODY_CONFIRMED,
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /Already recorded/);
});

test("a manual comped grant is NEVER overwritten by a paid row from the SU list", () => {
  const decision = imports.planCommitRow(
    row(),
    { tier: "comped", source: "manual" },
    NOBODY_CONFIRMED,
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /comped/);
  assert.match(decision.reason, /manual grant/);
});

test("an unmatched or duplicate row is skipped with a reason, never committed", () => {
  for (const matchKind of ["none", "duplicate"]) {
    const decision = imports.planCommitRow(
      row({ matchKind, matchedUid: matchKind === "none" ? null : "u-ada" }),
      null,
      NOBODY_CONFIRMED,
    );
    assert.equal(decision.action, "skip", matchKind);
    assert.notEqual(decision.reason, "");
  }
});

test("tier deltas add up per tier, which is how the period totals move once per call", () => {
  assert.deepEqual(imports.tierDeltas(["paid", "paid", "comped"]), { paid: 2, comped: 1 });
  assert.deepEqual(imports.tierDeltas([]), {});
});

// ---------------------------------------------------------------------------
// 7. The list projection
// ---------------------------------------------------------------------------

test("a row carries the six things the table needs and nothing else", () => {
  const projected = list.projectMembershipRow(
    "u-ada",
    {
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      role: "pending",
      // Everything below must NOT come out the other side.
      profile: {
        preferredName: "Ada",
        universityEmail: "ada@nottingham.ac.uk",
        uniEmailVerifiedAt: new Date(),
        motivation: "a long essay about why I want to join",
        interests: ["alignment"],
      },
      paidMembershipYears: ["2026/27"],
    },
    {
      tier: "paid",
      source: "su-import",
      matchedOn: "uni-email",
      provenance: { at: new Date("2026-10-09T12:00:00Z"), byUid: "u-admin" },
    },
    false,
    new Map([["u-admin", "Sam Admin"]]),
  );
  assert.deepEqual(Object.keys(projected).sort(), [
    "displayName",
    "email",
    "lapsed",
    "matchedOn",
    "preferredName",
    "recordedAt",
    "recordedByName",
    "role",
    "source",
    "tier",
    "uid",
    "uniEmailVerified",
    "universityEmail",
  ]);
  assert.equal(projected.recordedByName, "Sam Admin");
  assert.equal(projected.recordedAt, "2026-10-09T12:00:00.000Z");
  assert.equal(projected.uniEmailVerified, true);
});

test("no membership is nulls all the way down, and lapsed needs the period before", () => {
  const none = list.projectMembershipRow("u", { role: "member" }, null, false, new Map());
  assert.equal(none.tier, null);
  assert.equal(none.source, null);
  assert.equal(none.matchedOn, null);
  assert.equal(none.recordedAt, null);
  assert.equal(none.lapsed, false);

  const lapsed = list.projectMembershipRow("u", { role: "member" }, null, true, new Map());
  assert.equal(lapsed.lapsed, true);
});

test("somebody recorded THIS period is never lapsed, whatever last period says", () => {
  const projected = list.projectMembershipRow(
    "u",
    { role: "member" },
    {
      tier: "paid",
      source: "manual",
      matchedOn: "manual",
      provenance: { at: null, byUid: "" },
    },
    true,
    new Map(),
  );
  assert.equal(projected.lapsed, false);
});

test("the previous period is the one before among the periods that EXIST", () => {
  const ids = ["2024-25", "2026-27", "2027-28"];
  assert.equal(list.previousPeriodId(ids, "2026-27"), "2024-25");
  assert.equal(
    list.previousPeriodId(ids, "2024-25"),
    null,
    "the earliest period has nobody to have lapsed from",
  );
});

test("the filter searches names and both addresses, and can put unapproved accounts away", () => {
  const rows = [
    { ...list.projectMembershipRow("a", { displayName: "Ada Lovelace", role: "member" }, null, false, new Map()) },
    { ...list.projectMembershipRow("b", { displayName: "Bob", email: "bob@x.com", role: "pending" }, null, true, new Map()) },
    { ...list.projectMembershipRow("c", { displayName: "Cleo", role: "rejected" }, null, false, new Map()) },
  ];
  assert.equal(list.filterMembershipRows(rows, { query: "ada" }).length, 1);
  assert.equal(list.filterMembershipRows(rows, { query: "BOB@X" }).length, 1);
  assert.equal(
    list.filterMembershipRows(rows, { includeUnapproved: false }).length,
    1,
    "the switch hides rejected accounts as well as pending ones, which is why "
      + "it is not called `includePending`",
  );
  assert.equal(list.filterMembershipRows(rows, { onlyLapsed: true }).length, 1);
  assert.equal(list.filterMembershipRows(rows, { tier: "untagged" }).length, 3);
  assert.equal(list.filterMembershipRows(rows, { tier: "paid" }).length, 0);
  assert.equal(
    list.filterMembershipRows(rows, { query: "a" }).length,
    1,
    "a uid is not searched: pasting somebody else's uid must not look like a hit",
  );
});

test("the derived counts are what the table says they are", () => {
  const rows = [
    list.projectMembershipRow("a", { role: "member" }, null, false, new Map()),
    list.projectMembershipRow("b", { role: "member" }, null, true, new Map()),
    list.projectMembershipRow(
      "c",
      { role: "member" },
      { tier: "paid", source: "manual", matchedOn: "manual", provenance: { at: null, byUid: "" } },
      false,
      new Map(),
    ),
  ];
  assert.deepEqual(list.deriveCounts(rows), { untagged: 2, lapsed: 1 });
});

// ---------------------------------------------------------------------------
// 8. The account-deletion sweep
// ---------------------------------------------------------------------------

/**
 * A store with just enough shape for the sweep: a collection-group query over
 * `rows`, each document knowing its grandparent collection, and a write batch.
 *
 * The query supports the cursor, because paging IS the property under test.
 * Documents come back in full-path order, which is what Firestore's implicit
 * `__name__` ordering means for a collection group, and `startAfter` takes the
 * last snapshot of the previous page.
 */
function makeStore(rows, pageSize = 500) {
  const docs = new Map(Object.entries(rows));
  let batches = 0;

  function snap(path, data) {
    const segments = path.split("/");
    return {
      id: segments[segments.length - 1],
      path,
      data: () => ({ ...data }),
      ref: {
        path,
        parent: { parent: { parent: { id: segments[0] } } },
      },
    };
  }

  function run(uid, after, limit) {
    const all = [...docs.entries()]
      .filter(([, data]) => data.matchedUid === uid)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, data]) => snap(path, data));
    const from = after ? all.findIndex((d) => d.path === after.path) + 1 : 0;
    // Firestore caps a page at whatever the query asked for; this store also
    // caps it at `pageSize` so a test can force a small page.
    return all.slice(from, from + Math.min(limit, pageSize));
  }

  function queryFor(uid, spec) {
    return {
      orderBy(field) {
        assert.equal(field, "__name__", "the sweep pages on the document id");
        return queryFor(uid, { ...spec, ordered: true });
      },
      limit(n) {
        return queryFor(uid, { ...spec, limit: n });
      },
      startAfter(cursor) {
        return queryFor(uid, { ...spec, after: cursor });
      },
      async get() {
        assert.ok(spec.ordered, "startAfter without an orderBy is not a query");
        const found = run(uid, spec.after, spec.limit ?? 500);
        return { empty: found.length === 0, size: found.length, docs: found };
      },
    };
  }

  return {
    docs,
    get batches() {
      return batches;
    },
    collectionGroup(name) {
      assert.equal(name, "rows");
      return {
        where(field, op, value) {
          assert.equal(field, "matchedUid");
          assert.equal(op, "==");
          return queryFor(value, { ordered: false, limit: null, after: null });
        },
      };
    },
    batch() {
      const queued = [];
      return {
        delete(ref) {
          queued.push(ref.path);
        },
        async commit() {
          batches += 1;
          for (const path of queued) docs.delete(path);
        },
      };
    },
  };
}

test("the sweep deletes this account's rows and leaves everybody else's", async () => {
  const store = makeStore({
    "membershipImports/b1/rows/0001": { matchedUid: "u-ada", name: "Ada" },
    "membershipImports/b1/rows/0002": { matchedUid: "u-bob", name: "Bob" },
    "membershipImports/b2/rows/0001": { matchedUid: "u-ada", name: "Ada" },
    // Never matched to anybody: a line from a file the society received, about
    // somebody with no account here. It is not this deletion's to take.
    "membershipImports/b2/rows/0002": { matchedUid: null, name: "Stranger" },
  });

  const deleted = await deleteMembershipImportRows(store, "u-ada");

  assert.equal(deleted, 2);
  assert.deepEqual([...store.docs.keys()], [
    "membershipImports/b1/rows/0002",
    "membershipImports/b2/rows/0002",
  ]);
});

test("the BATCH documents are never touched: they are the provenance", async () => {
  const store = makeStore({
    "membershipImports/b1": { periodId: "2026-27", totalRows: 2 },
    "membershipImports/b1/rows/0001": { matchedUid: "u-ada" },
  });
  await deleteMembershipImportRows(store, "u-ada");
  assert.ok(
    store.docs.has("membershipImports/b1"),
    "deleting the batch would leave every membership it wrote claiming a "
      + "source with nothing behind it",
  );
});

test("a `rows` subcollection belonging to something else is left alone", async () => {
  // The collection-group name is short and generic. A future feature with its
  // own `rows` must not be swept by an account deletion.
  const store = makeStore({
    "somethingElse/x/rows/0001": { matchedUid: "u-ada" },
  });
  const deleted = await deleteMembershipImportRows(store, "u-ada");
  assert.equal(deleted, 0);
  assert.equal(store.docs.size, 1);
  assert.equal(store.batches, 0);
});

test("a whole page of somebody else's `rows` does not strand the ones after it", async () => {
  // The page size is 300. Three hundred documents from a DIFFERENT `rows`
  // collection group, all naming this uid, sorted ahead of ours by path: one
  // full page that the guard skips and the batch therefore deletes nothing on.
  //
  // Re-querying from the top hands back that same page forever, so the old
  // sweep stopped there and the real import row behind it survived the account
  // deletion for good. Paging on a cursor walks past it.
  const seeded = {};
  for (let i = 1; i <= 300; i += 1) {
    seeded[`aSomethingElse/x/rows/${String(i).padStart(4, "0")}`] = { matchedUid: "u-ada" };
  }
  seeded["membershipImports/b1/rows/0001"] = { matchedUid: "u-ada", name: "Ada" };

  const store = makeStore(seeded);
  const deleted = await deleteMembershipImportRows(store, "u-ada");

  assert.equal(deleted, 1, "the row behind the foreign page is still ours to delete");
  assert.equal(store.docs.has("membershipImports/b1/rows/0001"), false);
  assert.equal(
    store.docs.size,
    300,
    "and the foreign collection group is left exactly as it was",
  );
});

test("an account with no import rows writes nothing at all", async () => {
  const store = makeStore({ "membershipImports/b1/rows/0001": { matchedUid: "u-bob" } });
  assert.equal(await deleteMembershipImportRows(store, "u-ada"), 0);
  assert.equal(store.batches, 0);
});

test("the cascade actually calls the sweep", () => {
  const source = readFileSync(
    join(SRC, "lib", "firestore", "accountDeletion.ts"),
    "utf8",
  );
  assert.match(
    source,
    /summary\.membershipImportRowsDeleted = await deleteMembershipImportRows\(db, uid\)/,
    "a sweep nothing calls is a sweep that does not happen",
  );
});
