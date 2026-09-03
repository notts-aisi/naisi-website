/**
 * The applicant status hub and the admissions lifecycle emails.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing rather than reading
 *
 *  1. **`buildStatusRow` IS the disclosure boundary.** `admissionApplications`
 *     is `allow read, write: if false`, so nothing in Firestore stops a
 *     server-side surface handing an applicant the whole document. The row
 *     carries a facilitator's private written assessment of them
 *     (`evidence.facilitatorNotes`) and a rejection reason the decider may
 *     deliberately not have shared. So the tests below build a row with all of
 *     that on it, serialise the result the way the wire does, and assert the
 *     sentinel strings are NOWHERE in the JSON. A key-by-key check would pass
 *     the day somebody spreads a nested object.
 *  2. **The share gate.** `outcome.reasonShared` is one boolean, and it is the
 *     only thing standing between "we could not offer you a place" and an
 *     internal note about somebody. Both arms are executed.
 *  3. **The release boundary, through the hub.** The hub renders stages, so it
 *     is a second path from a stored question to a browser. The unreleased arm
 *     must have no `questions` key at all, for the same reason it must not on
 *     the apply page.
 *  4. **The ordering.** `sortStatusRows` is executed rather than eyeballed
 *     because an unstable list of applications reads as the site losing one.
 *
 * ## What is pinned against the source instead
 *
 * The two sends fire after a transaction commits, in routes that cannot run
 * without a database. The pins below find the transaction's closing
 * parenthesis and assert the send call sits AFTER it, which is the difference
 * between "the receipt cannot fail the submission" and "the receipt is inside
 * the retry loop". Same technique as `tests/admissions-apply-flow.test.mjs`.
 *
 * ## Why the loader dance
 *
 * Same root cause as the sibling admissions tests: this repo's Node predates
 * the v22.18 that strips TypeScript natively, so the module graph is
 * transpiled in memory with the `typescript` devDependency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. NOTHING BELOW IS REACHABLE FROM AN
 * ASSERTION IN THIS FILE: only the send path touches the email components, the
 * transport and the Admin SDK, and calling it would put real mail on the wire,
 * which is the one thing a unit test of this feature must never do. The stubs
 * are what let the send helper's own token contract be IMPORTED and compared
 * with the seed copy, rather than pattern-matched out of its source.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  ["@/emails/AdmissionsSubmittedEmail", "export default function Stub() { return null; }"],
  ["@/emails/AdmissionsReinstatedEmail", "export default function Stub() { return null; }"],
  // The scheduler's reminder and the appointment round's two decisions.
  // Stubbed for the same reason as the pair above: the send helper imports all
  // five, and a real `.tsx` here would be transpiled without the JSX option and
  // throw before a single assertion ran.
  [
    "@/emails/AdmissionsDeadlineReminderEmail",
    "export default function Stub() { return null; }",
  ],
  [
    "@/emails/AdmissionsStageReleasedEmail",
    "export default function Stub() { return null; }",
  ],
  ["@/emails/AdmissionsAppointedEmail", "export default function Stub() { return null; }"],
  ["@/emails/AdmissionsDeclinedEmail", "export default function Stub() { return null; }"],
  ["@/lib/firebase/admin", "export function getAdminDb() { return null; }"],
  ["@/lib/firestore/suppression", "export async function isSuppressed() { return false; }"],
  ["./send", "export async function sendEmail() {}"],
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

const hub = await loadTs("lib/admissions/statusHub.ts");
const emails = await loadTs("lib/firestore/courseEmails.ts");
const samples = await loadTs("features/admin/emailDesigns/courseEmailSamples.ts");
const blurbs = await loadTs("features/admissions/applicationStatus.ts");
const sendHelper = await loadTs("lib/email/admissionEmails.ts");

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

const SUBMIT_ROUTE = "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts";
const APPLY_ROUTE = "src/app/api/admissions/rounds/[roundId]/apply/route.ts";
const ME_ROUTE = "src/app/api/admissions/applications/me/route.ts";
const LOADER = "src/lib/admissions/statusHubData.ts";
const HUB_PAGE = "src/app/(public)/applications/page.tsx";
const HUB_DETAIL = "src/app/(public)/applications/[roundId]/page.tsx";
const PROXY = "src/proxy.ts";
const SEND_HELPER = "src/lib/email/admissionEmails.ts";

/**
 * The span of a handler's `db.runTransaction(...)` call, found by matching the
 * parenthesis it opens with. Quoted strings are skipped, so copy containing a
 * bracket cannot end the scan early.
 */
function transactionSpan(handlerSource) {
  const at = handlerSource.indexOf("db.runTransaction(");
  assert.ok(at !== -1, "this handler runs no transaction at all");
  const open = handlerSource.indexOf("(", at);
  let depth = 0;
  let quote = "";
  for (let i = open; i < handlerSource.length; i += 1) {
    const ch = handlerSource[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i, body: handlerSource.slice(open + 1, i) };
    }
  }
  throw new Error("unbalanced parentheses after db.runTransaction(");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRID = { version: 1, startMinute: 9 * 60, endMinute: 18 * 60, slotMinutes: 15 };
const NOW = new Date("2026-10-20T12:00:00Z");

/** Strings that must never leave the server on this surface. */
const FACILITATOR_NOTE = "SENTINEL-facilitator-said-he-was-quiet-in-sessions";
const UNSHARED_REASON = "SENTINEL-weaker-than-the-others-on-the-technical-side";
const STORED_EMAIL = "sentinel-applicant@example.com";

function makeRound(overrides = {}) {
  return {
    id: "autumn-2026-intake__k3f9a2b1",
    kind: "enrolment",
    label: "Autumn 2026 intake",
    slug: "autumn-2026",
    blurb: "Two programmes, one form.",
    academicYear: "2026/27",
    status: "closed",
    opensAt: new Date("2026-09-21T08:00:00Z"),
    closesAt: new Date("2026-10-18T22:59:00Z"),
    decisionsByDate: "2026-10-23",
    stageIds: ["s1", "s2"],
    programmePreference: {
      enabled: true,
      streams: [
        { id: "technical", label: "Technical" },
        { id: "governance", label: "Governance" },
      ],
      fellowships: [{ id: "agi-strategy", label: "AGI Strategy" }],
      maxRankedFellowships: 3,
      offerFellowshipFallback: true,
    },
    availabilityGrid: GRID,
    accessRequirementsPrompt: "Anything we should know?",
    criteria: [{ id: "c1", label: "Motivation", weight: 1 }],
    scoreScale: { min: 1, max: 5 },
    reviewersPerApplication: 2,
    reviewerUids: ["reviewer-1", "reviewer-2"],
    finalDeciderUid: "decider-1",
    blind: { names: true, membership: true },
    evidenceRunIds: [],
    reminderOffsets: [],
    outcomeRunIds: ["run-1"],
    applicationCounts: { draft: 3, submitted: 41, accepted: 12 },
    archived: false,
    clonedFromRoundId: null,
    authorUid: "author-1",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeStage(id, order, overrides = {}) {
  return {
    id,
    roundId: "autumn-2026-intake__k3f9a2b1",
    label: `Part ${order + 1}`,
    intro: "Answer in your own words.",
    questions: [
      { id: "q1", type: "longText", label: "Why this programme?", required: true },
    ],
    releaseAt: null,
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: true,
    order,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeApplication(overrides = {}) {
  return {
    id: "autumn-2026-intake__k3f9a2b1__uid-1",
    roundId: "autumn-2026-intake__k3f9a2b1",
    uid: "uid-1",
    email: STORED_EMAIL,
    displayName: "Alex Taylor",
    stageAnswers: { s1: { q1: "Because I want to work on this." } },
    stageSubmittedAt: { s1: new Date("2026-10-17T18:00:00Z") },
    availability: { ...GRID, days: ["0", "0", "0", "0", "0", "0", "0"] },
    availabilityConfigVersion: 1,
    programmePreference: {
      streamId: "technical",
      rankedFellowshipIds: ["agi-strategy"],
      openToFellowship: true,
    },
    evidence: {
      runs: [{ runId: "run-0", sessionsHeld: 6, attendedInFull: 5, submissionDone: true }],
      facilitatorNotes: FACILITATOR_NOTE,
      computedAt: new Date("2026-10-18T00:00:00Z"),
    },
    membershipAtApply: true,
    reapplyCount: 1,
    status: "rejected",
    submittedAt: new Date("2026-10-17T18:00:00Z"),
    withdrawnAt: null,
    outcome: {
      decision: "reject",
      targetRunId: null,
      streamId: null,
      decidedByUid: "decider-1",
      decidedAt: new Date("2026-10-22T10:00:00Z"),
      reason: UNSHARED_REASON,
      reasonShared: false,
    },
    seatApplicationId: null,
    createdAt: new Date("2026-10-01T09:00:00Z"),
    updatedAt: new Date("2026-10-22T10:00:00Z"),
    ...overrides,
  };
}

function wire(row) {
  return JSON.stringify(row);
}

// ---------------------------------------------------------------------------
// The projection: what an applicant may see
// ---------------------------------------------------------------------------

describe("the status row projection", () => {
  test("the reviewer evidence never reaches the wire", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0), makeStage("s2", 1)],
      NOW,
    );
    assert.ok(
      !wire(row).includes(FACILITATOR_NOTE),
      "a facilitator's private assessment of this applicant is on the wire",
    );
    assert.equal("evidence" in row.application, false);
  });

  test("an unshared decision reason never reaches the wire", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.sharedDecisionReason, "");
    assert.ok(
      !wire(row).includes(UNSHARED_REASON),
      "the decider did not tick share, and the reason is on the wire anyway",
    );
  });

  test("a SHARED decision reason does reach the applicant", () => {
    const shared = "We had more strong applications than seats this term.";
    const row = hub.buildStatusRow(
      makeApplication({
        outcome: {
          ...makeApplication().outcome,
          reason: shared,
          reasonShared: true,
        },
      }),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.sharedDecisionReason, shared);
  });

  test("the stored email address is never echoed back", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.ok(!wire(row).includes(STORED_EMAIL));
    assert.equal("email" in row.application, false);
  });

  test("no staff-only key survives the projection", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    for (const key of [
      "email",
      "evidence",
      "outcome",
      "membershipAtApply",
      "seatApplicationId",
      "displayName",
    ]) {
      assert.equal(key in row.application, false, `application.${key} is on the wire`);
    }
    for (const key of [
      "applicationCounts",
      "reviewerUids",
      "finalDeciderUid",
      "criteria",
      "scoreScale",
      "blind",
      "authorUid",
    ]) {
      assert.equal(key in row.round, false, `round.${key} is on the wire`);
    }
  });

  test("the access-requirements answer is never joined here", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    // The hub logs nothing, so it reads nothing: the promise in the privacy
    // policy is that every read of that answer is recorded.
    assert.equal(row.application.accessRequirements, "");
  });

  test("an unreleased stage carries no questions key at all", () => {
    const round = makeRound({ status: "open", closesAt: new Date("2026-11-30T23:59:00Z") });
    const unseen = "SENTINEL-the-week-three-essay-question";
    const later = makeStage("s2", 1, {
      releaseAt: "2026-11-01",
      releaseTimeLocal: "09:00",
      intro: unseen,
      questions: [{ id: "q2", type: "longText", label: unseen, required: true }],
    });
    const row = hub.buildStatusRow(makeApplication(), round, [makeStage("s1", 0), later], NOW);
    const unreleased = row.stages.find((stage) => stage.id === "s2");
    assert.equal(unreleased.released, false);
    assert.equal("questions" in unreleased, false);
    // Not "the key is there but empty": the unreleased arm is a different,
    // smaller object which has never held the questions at any point in its
    // construction. Nor `questionCount`, which would leak how long the unseen
    // part is, nor `intro`, which is authored prose about the questions.
    assert.equal("questionCount" in unreleased, false);
    assert.equal("intro" in unreleased, false);
    assert.ok(
      !wire(row).includes(unseen),
      "an unreleased question reached the applicant through the status hub",
    );
  });

  test("a stored field nobody serialised never reaches the applicant", () => {
    // `serialiseStage` lists its fields rather than spreading the document, so
    // a field written by an older build, a migration or a staff tool that got
    // ahead of the normaliser cannot ride out to whoever asked.
    const sentinel = "SENTINEL-internal-marker-scribble";
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0, { internalNote: sentinel, reviewerUids: ["reviewer-1"] })],
      NOW,
    );
    assert.ok(
      !wire(row).includes(sentinel),
      "an unlisted stage field reached the applicant through the status hub",
    );
    assert.equal("internalNote" in row.stages[0], false);
    assert.equal("reviewerUids" in row.stages[0], false);
  });

  test("a released stage does carry its questions, so answers can be labelled", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    const released = row.stages[0];
    assert.equal(released.released, true);
    assert.equal(released.questions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Next stage, links and ordering
// ---------------------------------------------------------------------------

describe("what the applicant is told to do next", () => {
  const openRound = () =>
    makeRound({ status: "open", closesAt: new Date("2026-11-30T23:59:00Z") });

  test("the next stage is the first one not yet frozen", () => {
    const stages = [makeStage("s1", 0), makeStage("s2", 1)];
    const row = hub.buildStatusRow(
      makeApplication({ status: "draft", outcome: { ...makeApplication().outcome, decision: null } }),
      openRound(),
      stages,
      NOW,
    );
    assert.equal(row.nextStage.id, "s2");
    assert.equal(row.nextStage.released, true);
  });

  test("an unreleased next stage carries its date and nothing else", () => {
    const stages = [
      makeStage("s1", 0),
      makeStage("s2", 1, { releaseAt: "2026-11-01", releaseTimeLocal: "09:00" }),
    ];
    const row = hub.buildStatusRow(
      makeApplication({ status: "submitted" }),
      openRound(),
      stages,
      NOW,
    );
    assert.equal(row.nextStage.id, "s2");
    assert.equal(row.nextStage.released, false);
    assert.equal(typeof row.nextStage.releasesAt, "string");
  });

  test("every stage frozen means there is nothing to do next", () => {
    const stages = [makeStage("s1", 0), makeStage("s2", 1)];
    const row = hub.buildStatusRow(
      makeApplication({
        status: "submitted",
        stageSubmittedAt: {
          s1: new Date("2026-10-17T18:00:00Z"),
          s2: new Date("2026-10-18T18:00:00Z"),
        },
      }),
      openRound(),
      stages,
      NOW,
    );
    assert.equal(row.nextStage, null);
  });

  test("a decided application is never told a stage opens on Monday", () => {
    const stages = [
      makeStage("s1", 0),
      makeStage("s2", 1, { releaseAt: "2026-11-01", releaseTimeLocal: "09:00" }),
    ];
    for (const status of ["accepted", "rejected", "waitlisted", "withdrawn", "fellowship-offered"]) {
      const row = hub.buildStatusRow(
        makeApplication({ status }),
        openRound(),
        stages,
        NOW,
      );
      assert.equal(row.nextStage, null, `${status} was offered a next stage`);
    }
  });

  test("a draft links to the form to carry on with, a sent one to read back", () => {
    const draft = hub.buildStatusRow(
      makeApplication({ status: "draft" }),
      openRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(draft.hrefKind, "resume");
    assert.equal(draft.href, "/apply/autumn-2026-intake__k3f9a2b1");

    const sent = hub.buildStatusRow(
      makeApplication({ status: "submitted" }),
      openRound(),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(sent.hrefKind, "view");
    assert.equal(sent.href, "/apply/autumn-2026-intake__k3f9a2b1");
  });

  test("a draft the deadline overtook is not offered a form to carry on with", () => {
    // The blurb above the link says it was never sent. "Carry on writing it"
    // underneath would be the same card contradicting itself, and the form it
    // pointed at renders read-only anyway.
    const row = hub.buildStatusRow(
      makeApplication({ status: "draft" }),
      makeRound({ status: "closed" }),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.round.windowState, "closed");
    assert.notEqual(row.hrefKind, "resume");
    assert.equal(row.hrefKind, "view");
    // The link stays: `/apply/[roundId]` reads a closed round's draft back in
    // full ("This one was never sent", every answer still there).
    assert.equal(row.href, "/apply/autumn-2026-intake__k3f9a2b1");
  });

  test("a draft on an archived round is neither resumable nor linked", () => {
    const row = hub.buildStatusRow(
      makeApplication({ status: "draft" }),
      makeRound({ archived: true }),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.round.windowState, "inactive");
    assert.notEqual(row.hrefKind, "resume");
    // `/apply/[roundId]` answers 404 for an archived round, so there is no
    // link to give: the row says what happened in its own words instead.
    assert.equal(row.href, null);
    assert.equal(row.application.stageAnswers.s1.q1, "Because I want to work on this.");
  });

  test("an archived round's row still renders, with no dead link on it", () => {
    const row = hub.buildStatusRow(
      makeApplication(),
      makeRound({ archived: true }),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.round.windowState, "inactive");
    assert.equal(row.href, null);
    // The answers are still theirs.
    assert.equal(row.application.stageAnswers.s1.q1, "Because I want to work on this.");
  });

  test("the closed window does not hide anything: this page outlives the deadline", () => {
    const row = hub.buildStatusRow(
      makeApplication({ status: "submitted" }),
      makeRound({ status: "closed" }),
      [makeStage("s1", 0)],
      NOW,
    );
    assert.equal(row.round.windowState, "closed");
    assert.equal(row.application.status, "submitted");
    assert.equal(row.href, "/apply/autumn-2026-intake__k3f9a2b1");
  });
});

describe("ordering", () => {
  const rowWith = (updatedAt, label) => ({
    round: { label },
    application: { updatedAt },
  });

  test("most recently touched first", () => {
    const sorted = hub.sortStatusRows([
      rowWith("2026-09-01T10:00:00.000Z", "Spring"),
      rowWith("2026-10-22T10:00:00.000Z", "Autumn"),
    ]);
    assert.deepEqual(
      sorted.map((row) => row.round.label),
      ["Autumn", "Spring"],
    );
  });

  test("a row with no timestamp sorts last rather than randomly", () => {
    const sorted = hub.sortStatusRows([
      rowWith(null, "Nameless"),
      rowWith("2026-10-22T10:00:00.000Z", "Autumn"),
    ]);
    assert.deepEqual(
      sorted.map((row) => row.round.label),
      ["Autumn", "Nameless"],
    );
  });

  test("the tie-break is total, so the list never reshuffles between renders", () => {
    const at = "2026-10-22T10:00:00.000Z";
    const first = hub.sortStatusRows([rowWith(at, "B"), rowWith(at, "A")]);
    const second = hub.sortStatusRows([rowWith(at, "A"), rowWith(at, "B")]);
    assert.deepEqual(
      first.map((row) => row.round.label),
      second.map((row) => row.round.label),
    );
    assert.deepEqual(
      first.map((row) => row.round.label),
      ["A", "B"],
    );
  });
});

describe("the sentence under the chip", () => {
  const draft = (windowState) => blurbs.applicationStatusBlurb("draft", windowState);

  test("an open window invites the applicant to finish it", () => {
    assert.match(draft("open"), /Saved but not sent/);
    assert.match(draft("not-yet"), /Saved but not sent/);
  });

  test("a closed window says plainly that it was never sent", () => {
    assert.match(draft("closed"), /never sent to us/);
    assert.ok(!/until you submit it/.test(draft("closed")));
  });

  test("an inactive round gets its own sentence, not the open one", () => {
    // A draft or archived round resolves to `inactive`, not `closed`. Before
    // this arm existed it fell through to "it stays exactly as you left it
    // until you submit it", on a row whose form answers 404 and which the hub
    // does not even link to.
    const inactive = draft("inactive");
    assert.match(inactive, /no longer taking applications/);
    assert.ok(!/until you submit it/.test(inactive));
    assert.notEqual(inactive, draft("open"));
  });

  test("the window changes nothing for a status that is not a draft", () => {
    for (const status of ["submitted", "accepted", "rejected", "withdrawn", "waitlisted"]) {
      const seen = new Set(
        ["open", "not-yet", "closed", "inactive"].map((state) =>
          blurbs.applicationStatusBlurb(status, state),
        ),
      );
      assert.equal(seen.size, 1, `${status} says different things in different windows`);
    }
  });

  test("every status has a sentence", () => {
    for (const status of [
      "draft",
      "submitted",
      "accepted",
      "fellowship-offered",
      "waitlisted",
      "rejected",
      "withdrawn",
    ]) {
      assert.ok(
        blurbs.applicationStatusBlurb(status, "closed").length > 0,
        `${status} has no sentence`,
      );
    }
  });
});

describe("answerText", () => {
  test("every stored answer shape becomes a sentence, never [object Object]", () => {
    assert.equal(hub.answerText(undefined), "");
    assert.equal(hub.answerText("written"), "written");
    assert.equal(hub.answerText(true), "Yes");
    assert.equal(hub.answerText(false), "No");
    assert.equal(hub.answerText(["a", "b"]), "a, b");
    assert.equal(hub.answerText({ checked: ["a"], other: " nuts " }), "a, Other: nuts");
    assert.equal(hub.answerText({ checked: ["a"], other: "" }), "a");
  });
});

// ---------------------------------------------------------------------------
// Source pins: the surfaces that cannot run without a database
// ---------------------------------------------------------------------------

describe("the hub reads nothing it does not log", () => {
  test("neither the loader nor the route can reach the private collection", () => {
    for (const file of [LOADER, ME_ROUTE, HUB_PAGE, HUB_DETAIL]) {
      const src = source(file);
      assert.ok(
        !/admissionApplicationPrivate|privateRef/.test(src),
        `${file} reaches the access-requirements collection. The privacy policy ` +
          "promises every read of that answer is recorded, and this surface records " +
          "nothing.",
      );
    }
  });

  test("neither the loader nor the route imports the apply context", () => {
    // `applyContext.ts` exports `privateRef` and `loadOwnApplication`, both of
    // which address `admissionApplicationPrivate`, and the privacy scan treats
    // importing it as being able to reach that collection. The collection NAME
    // lives on the firestore leaf module for exactly this reason: a string
    // constant is not a reason to give up the guarantee.
    for (const file of [LOADER, ME_ROUTE]) {
      const src = source(file);
      assert.ok(
        !/applyContext/.test(src),
        `${file} imports the apply context, which can address the ` +
          "access-requirements collection on a caller's behalf",
      );
    }
    assert.match(
      source(LOADER),
      /APPLICATIONS_COLLECTION,?\n?[^}]*\}\s*from\s*"@\/lib\/firestore\/admissionApplications"/,
      "the loader no longer takes the collection name from the firestore leaf",
    );
  });

  test("the route addresses the caller's own rows and nobody else's", () => {
    const src = source(ME_ROUTE);
    assert.match(src, /requireApplicant\(\)/);
    assert.match(src, /loadStatusRows\(db, user\.uid/);
  });

  test("the single-round read is addressed by id, not queried", () => {
    const src = source(LOADER);
    assert.match(src, /admissionApplicationId\(roundId, uid\)/);
    assert.ok(
      !/where\("uid", "==", [^u]/.test(src),
      "the uid filter comes from somewhere other than the session",
    );
  });

  test("/applications is protected by the proxy, prefix and matcher both", () => {
    const src = source(PROXY);
    const prefixes = /const PROTECTED_PREFIXES = \[([^\]]*)\]/.exec(src);
    assert.ok(prefixes, "PROTECTED_PREFIXES is no longer an array literal");
    assert.match(prefixes[1], /"\/applications"/);
    const matcher = /matcher: \[([^\]]*)\]/.exec(src);
    assert.ok(matcher, "the matcher is no longer an array literal");
    assert.match(matcher[1], /"\/applications\/:path\*"/);
  });
});

describe("the lifecycle sends happen after the commit", () => {
  test("the submitted receipt is outside the submit transaction", () => {
    const src = source(SUBMIT_ROUTE);
    const span = transactionSpan(src);
    const at = src.indexOf("sendAdmissionEmail(");
    assert.ok(at !== -1, "the submit route sends no receipt at all");
    assert.ok(
      at > span.end,
      "the receipt is sent INSIDE the transaction, so a Firestore retry would " +
        "mail the applicant twice and a send failure would roll back a valid " +
        "submission",
    );
    assert.ok(!span.body.includes("sendAdmissionEmail("));
  });

  test("the reinstated note is outside the apply transaction, and only on the reopen branch", () => {
    const src = source(APPLY_ROUTE);
    const span = transactionSpan(src);
    const at = src.indexOf("sendAdmissionEmail(");
    assert.ok(at !== -1, "the apply route sends nothing when an application is reopened");
    assert.ok(at > span.end, "the note is sent inside the transaction");
    const guard = src.lastIndexOf('outcome === "reopened"', at);
    assert.ok(
      guard !== -1 && guard < at,
      "the reinstated note is not guarded on the reopen branch, so a brand new " +
        "application would be told it had been picked back up",
    );
  });

  test("neither send is awaited, so nobody waits on SMTP", () => {
    for (const file of [SUBMIT_ROUTE, APPLY_ROUTE]) {
      const src = source(file);
      assert.ok(
        /void sendAdmissionEmail\(/.test(src),
        `${file} awaits the send, so an SMTP stall holds the applicant's response open`,
      );
    }
  });

  test("the send helper checks suppression and swallows everything", () => {
    const src = source(SEND_HELPER);
    assert.match(src, /isSuppressed\(db, opts\.to\)/);
    const body = src.slice(src.indexOf("export async function sendAdmissionEmail"));
    assert.match(body, /try \{/);
    assert.match(body, /catch \(err\) \{[\s\S]*console\.error/);
    // A round is not a run: the three course tokens are dropped rather than
    // resolved to a blank. The filter is by kind, so this is asserted against
    // the map itself rather than against three delete statements. `appointed`
    // is left out because it DOES name a run, and that side is asserted in
    // `admissions-appointment-decide.test.mjs`.
    for (const kind of ROUND_ONLY_KINDS) {
      const supplied = sendHelper.TOKENS_BY_KIND[kind];
      for (const courseToken of ["courseTitle", "runLabel", "startDate"]) {
        assert.equal(
          supplied.includes(courseToken),
          false,
          `the ${kind} send resolves {${courseToken}}, and a round is not a run`,
        );
      }
    }
    assert.match(src, /const allowed = new Set<string>\(TOKENS_BY_KIND\[opts\.kind\]\)/);
  });
});

// ---------------------------------------------------------------------------
// The template registry
// ---------------------------------------------------------------------------

/**
 * Every template whose send path is `sendAdmissionEmail`. The two RECEIPTS
 * (this file's own subject), the scheduler's deadline reminder, and the
 * appointment round's two DECISIONS, which land with the appointment decide
 * path and have their own executed tests in
 * `admissions-appointment-decide.test.mjs`. They are all listed here because
 * the registry checks below are about the registry, not about a trigger: an id
 * with no label or no seed copy is broken whichever route sends it.
 */
const ADMISSIONS_IDS = [
  "admissions-submitted",
  "admissions-reinstated",
  "admissions-deadline-reminder",
  "admissions-stage-released",
  "admissions-appointed",
  "admissions-declined",
];

/** The kinds `sendAdmissionEmail` accepts, in the same order as the ids above. */
const ADMISSIONS_KINDS = [
  "submitted",
  "reinstated",
  "deadline-reminder",
  "stage-released",
  "appointed",
  "declined",
];

/**
 * The kinds that know a ROUND and nothing more, which is every kind but
 * `appointed`: an appointment has written the person onto a run, so it is the
 * one send that may name a course. The checks that assert a course token stays
 * literal run over this list rather than over every kind.
 */
const ROUND_ONLY_KINDS = ADMISSIONS_KINDS.filter((kind) => kind !== "appointed");

describe("the admissions email templates", () => {
  test("every id is registered, with a trigger, a label and seed copy", () => {
    for (const id of ADMISSIONS_IDS) {
      assert.ok(emails.COURSE_TEMPLATE_IDS.includes(id), `${id} is not a template id`);
      assert.equal(emails.isCourseTemplateId(id), true);
      assert.ok(emails.COURSE_TEMPLATE_TRIGGER[id], `${id} has no trigger`);
      assert.ok(emails.COURSE_DEFAULT_LABELS[id], `${id} has no label`);
      const seed = emails.courseTemplateDefaults[id];
      assert.ok(seed.subject.length > 0, `${id} has no subject`);
      assert.ok(seed.blocks.length > 0, `${id} has no body`);
    }
  });

  test("every token the seed copy uses is one THIS TRIGGER supplies", () => {
    // Per kind, not per helper. The helper ACCEPTS a `decisionsBy` and a
    // `stageLabel`; the reinstate call site passes neither, so a check against
    // what the helper can take would bless `{decisionsBy}` in the reinstated
    // copy and ship those thirteen characters to an applicant. `TOKENS_BY_KIND`
    // is the contract each trigger keeps, and the send path filters on it.
    for (const kind of ADMISSIONS_KINDS) {
      const id = sendHelper.TEMPLATE_FOR_KIND[kind];
      const supplied = new Set(sendHelper.TOKENS_BY_KIND[kind]);
      const seed = emails.courseTemplateDefaults[id];
      const text = seed.subject + JSON.stringify(seed.blocks);
      for (const [, token] of text.matchAll(/\{([a-zA-Z]+)\}/g)) {
        assert.ok(
          supplied.has(token),
          `${id}'s seed copy uses {${token}}, which the ${kind} trigger never ` +
            "supplies, so it would arrive as literal text in somebody's inbox",
        );
      }
    }
  });

  test("the admissions template ids are exactly the ones the send path knows", () => {
    assert.deepEqual(
      Object.values(sendHelper.TEMPLATE_FOR_KIND).sort(),
      [...ADMISSIONS_IDS].sort(),
    );
  });

  test("the seed copy does not put a url in a sentence", () => {
    // `personaliseBlocks` leaves an unresolved token literal, so a tokenised
    // link is a broken link the day a send path forgets to pass it. Both
    // components render the link themselves.
    for (const id of ADMISSIONS_IDS) {
      const seed = emails.courseTemplateDefaults[id];
      const text = seed.subject + JSON.stringify(seed.blocks);
      assert.ok(
        !text.includes("{applicationUrl}"),
        `${id}'s seed copy tokenises the application link; the component renders it`,
      );
    }
  });

  test("the designer's sample resolves exactly what a real send resolves", () => {
    for (const kind of ADMISSIONS_KINDS) {
      const id = sendHelper.TEMPLATE_FOR_KIND[kind];
      assert.equal(samples.courseTemplateUsesAdmissionsTokens(id), true);
      const tokens = samples.courseSampleTokens(id, "Alex Taylor");
      // A round is not a run: previewing a course token as resolved would show
      // an admin an email nobody receives. The appointment is the exception,
      // because it has written the person onto a run and names it; nobody is
      // ever placed on a cohort by an admissions send, so `cohortLabel` stays
      // unresolved on all five.
      const absentTokens =
        kind === "appointed"
          ? ["cohortLabel"]
          : ["courseTitle", "runLabel", "startDate", "cohortLabel"];
      for (const absent of absentTokens) {
        assert.equal(absent in tokens, false, `the preview resolves {${absent}}`);
      }
      // EXACTLY, both ways: every token this trigger supplies is previewed,
      // and nothing else is. A preview that filled in a token the trigger does
      // not pass is how an admin writes a sentence around it.
      assert.deepEqual(
        Object.keys(tokens).sort(),
        [...sendHelper.TOKENS_BY_KIND[kind]].sort(),
        `the ${id} preview and the ${kind} send resolve different tokens`,
      );
      for (const token of Object.keys(tokens)) {
        assert.ok(tokens[token], `the preview leaves {${token}} empty`);
      }
    }
  });

  test("the editor's token help is narrowed to the open template's trigger", () => {
    // The editor lists tokens from `admissionsTokensFor`, and this is the
    // assertion that the client-side copy of the contract still agrees with
    // the server-only one it mirrors.
    for (const kind of ADMISSIONS_KINDS) {
      const id = sendHelper.TEMPLATE_FOR_KIND[kind];
      assert.deepEqual(
        [...samples.admissionsTokensFor(id)].sort(),
        [...sendHelper.TOKENS_BY_KIND[kind]].sort(),
        `${id}'s editor help and its send path disagree about the tokens`,
      );
    }
    assert.equal(samples.admissionsTokensFor("course-allocated").size, 0);
  });

  test("course templates keep their own token pass", () => {
    assert.equal(samples.courseTemplateUsesAdmissionsTokens("course-allocated"), false);
    const tokens = samples.courseSampleTokens("course-allocated", "Alex Taylor");
    assert.ok(tokens.courseTitle);
    assert.equal("roundLabel" in tokens, false);
  });

  test("the token map carries every admissions token the contract names", () => {
    const built = emails.buildCourseTokens({
      user: { displayName: "Alex Taylor" },
      courseTitle: "",
      runLabel: "",
      startDate: "",
      applicationUrl: "https://naisi.uk/applications/r1",
      roundLabel: "Autumn 2026 intake",
      stageLabel: "Week 2 questions",
      deadline: "Sun 18 Oct, 23:59",
      decisionsBy: "Fri 23 Oct",
      cohortLabel: "Autumn 2026, cohort 2",
    });
    for (const key of [
      "applicationUrl",
      "roundLabel",
      "stageLabel",
      "deadline",
      "decisionsBy",
      "cohortLabel",
    ]) {
      assert.ok(built[key], `{${key}} is not on the token map`);
    }
  });

  test("an unsupplied admissions token is omitted, never blanked", () => {
    const built = emails.buildCourseTokens({
      user: { displayName: "Alex Taylor" },
      courseTitle: "",
      runLabel: "",
      startDate: "",
      roundLabel: "Autumn 2026 intake",
    });
    // Omitted means the literal `{stageLabel}` shows up in a test send and an
    // admin moves it. Blanked means a hole in a sentence nobody notices.
    assert.equal("stageLabel" in built, false);
    assert.equal("decisionsBy" in built, false);
  });
});
