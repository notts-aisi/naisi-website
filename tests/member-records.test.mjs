/**
 * The member record's pure halves: `buildApplicationRecord` (what an entry
 * says) and `normalizeApplicationRecord` (what survives a read), plus a source
 * pin that nothing client-side writes the collection.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * ## Why these two functions are executed rather than reasoned about
 *
 * An entry is the one thing a destroy is required to leave behind, and it
 * OUTLIVES EVERYTHING IT WAS DERIVED FROM. Once the round, the applications
 * and the reviews are gone there is nothing left to check it against, so a
 * mistake in the derivation is not a bug that gets found later: it is the
 * committee's permanent record of what somebody applied for and how it went,
 * quietly wrong. The arithmetic (which reviewers count towards a mean, what an
 * unscored review contributes) and the labels (what the person asked for, who
 * wrote which note) are therefore assertions rather than comments.
 *
 * ## What the source pin is for
 *
 * The write side of this collection is `allow write: if false` for every
 * client, admins included, and the rules suite proves that against the
 * emulator. This pin proves the other direction, at the source: no file under
 * `src/features` or `src/app/(app)` writes `memberRecords`, so nobody has
 * shipped a client-direct write that the deployed rules would refuse at
 * runtime, silently, on a surface nobody tests as a member. A read there is
 * fine and is expected: the rules grant one to admins and SU-recognised
 * committee on purpose.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * NO STUBS, and that is worth a line. `memberRecords.ts` imports
 * `firebase-admin/firestore` FOR TYPES ONLY (see its header: the pure half is
 * deliberately importable from a client module, and a value import would drag
 * the Admin SDK into a browser chunk), and TypeScript erases a type-only
 * import, so nothing in this graph reaches the outside world. The three
 * admissions modules it pulls in for their types are pure. If a stub ever
 * becomes necessary here, the reason is that this module gained a real
 * dependency, which is the point at which it should be split instead.
 */
const { loadTs } = createLoader({ stubs: new Map() });

const {
  MEMBER_RECORDS_COLLECTION,
  MEMBER_RECORD_APPLICATIONS,
  MEMBER_RECORD_LIMITS,
  OPEN_TO_FELLOWSHIP_LABEL,
  REMOVED_PROGRAMME_LABEL,
  UNNAMED_REVIEWER,
  buildApplicationRecord,
  normalizeApplicationRecord,
} = await loadTs("lib/firestore/memberRecords.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A round with two criteria and a programme-preference section offering one
 * stream and two fellowships. Deliberately the shape that exercises every
 * branch of `appliedFor` at once.
 */
function round(overrides = {}) {
  return {
    id: "autumn-2026",
    kind: "enrolment",
    label: "Autumn 2026 intake",
    slug: "autumn-2026",
    criteria: [
      { id: "motivation", label: "Motivation", guidance: "" },
      { id: "fit", label: "Fit", guidance: "" },
    ],
    programmePreference: {
      enabled: true,
      streams: [{ id: "s-tech", label: "Technical incubator" }],
      fellowships: [
        { id: "f-gov", label: "Governance fellowship" },
        { id: "f-int", label: "Interpretability fellowship" },
      ],
      maxRankedFellowships: 2,
      offerFellowshipFallback: true,
    },
    ...overrides,
  };
}

function application(overrides = {}) {
  return {
    id: "autumn-2026__applicant",
    roundId: "autumn-2026",
    uid: "applicant",
    email: "applicant@example.com",
    displayName: "An Applicant",
    status: "accepted",
    createdAt: new Date("2026-09-01T09:00:00Z"),
    submittedAt: new Date("2026-09-08T18:30:00Z"),
    withdrawnAt: null,
    programmePreference: {
      streamId: "s-tech",
      rankedFellowshipIds: ["f-int", "f-gov"],
      openToFellowship: true,
    },
    evidence: null,
    outcome: {
      decision: "accept",
      targetRunId: "run-tech-autumn",
      streamId: "s-tech",
      decidedByUid: "decider",
      decidedAt: new Date("2026-09-20T12:00:00Z"),
      reason: "Strong on both criteria.",
      reasonShared: false,
    },
    ...overrides,
  };
}

function review(reviewerUid, overrides = {}) {
  return {
    id: `autumn-2026__applicant__${reviewerUid}`,
    roundId: "autumn-2026",
    applicantUid: "applicant",
    reviewerUid,
    scores: { motivation: 4, fit: 3 },
    total: 7,
    recommendation: "advance",
    notes: `Notes from ${reviewerUid}.`,
    knowsApplicant: false,
    ...overrides,
  };
}

/** The three reviewers the arithmetic tests use, two scoring and one not. */
function threeReviews() {
  return [
    review("rev-a", { scores: { motivation: 5, fit: 4 }, total: 9 }),
    review("rev-b", { scores: { motivation: 2, fit: 3 }, total: 5 }),
    // Wrote notes and a recommendation, never touched the sliders. `total` is
    // 0 because it is the sum of an empty map, which is exactly the trap.
    review("rev-c", {
      scores: {},
      total: 0,
      recommendation: "hold",
      notes: "Could not get to the scoring, but worth a look.",
    }),
  ];
}

function build(overrides = {}) {
  return buildApplicationRecord({
    round: round(),
    application: application(),
    reviews: [],
    reviewerNames: {},
    writtenBy: "settle",
    writtenByUid: "admin1",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. What the entry says about the round and the outcome
// ---------------------------------------------------------------------------

describe("buildApplicationRecord: the round and the outcome", () => {
  it("copies the round's identity and the application's dates", () => {
    const record = build();
    assert.equal(record.roundId, "autumn-2026");
    assert.equal(record.roundTitle, "Autumn 2026 intake");
    assert.equal(record.roundKind, "enrolment");
    // `appliedAt` is the application's createdAt: when they STARTED it. An
    // application that was never submitted still happened, and the record says
    // so through a null submittedAt beside a real appliedAt.
    assert.deepEqual(record.appliedAt, new Date("2026-09-01T09:00:00Z"));
    assert.deepEqual(record.submittedAt, new Date("2026-09-08T18:30:00Z"));
  });

  it("records a never-submitted application as applied but not submitted", () => {
    const record = build({
      application: application({ status: "draft", submittedAt: null, outcome: {
        decision: null, targetRunId: null, streamId: null,
        decidedByUid: null, decidedAt: null, reason: "", reasonShared: false,
      } }),
    });
    assert.deepEqual(record.appliedAt, new Date("2026-09-01T09:00:00Z"));
    assert.equal(record.submittedAt, null);
    assert.equal(record.outcome.status, "draft");
    assert.equal(record.outcome.decision, null);
  });

  it("keeps the decision, the status and the run they were placed on", () => {
    const record = build();
    assert.deepEqual(record.outcome, {
      decision: "accept",
      status: "accepted",
      targetRunId: "run-tech-autumn",
    });
  });

  it("carries no applicant content: no email, no answers, no reason", () => {
    // The retention argument depends on this. The entry is kept through
    // account deletion because it is the committee's record of its own
    // decisions, and that is only true while it holds none of the applicant's
    // own writing. `outcome.reason` is the decider's message and is
    // deliberately absent: `reasonShared` decides whether the applicant ever
    // sees it, and an entry SU-recognised committee can read is not the place
    // to keep an unshared one.
    const record = build({ reviews: threeReviews(), reviewerNames: {} });
    const json = JSON.stringify(record);
    assert.ok(!json.includes("applicant@example.com"), "no email address");
    assert.ok(!json.includes("Strong on both criteria"), "no decider reason");
    assert.ok(!Object.hasOwn(record.outcome, "reason"));
    assert.ok(!Object.hasOwn(record, "stageAnswers"));
    assert.ok(!Object.hasOwn(record, "availability"));
  });

  it("stamps who wrote it and why", () => {
    const record = build({ writtenBy: "destroy", writtenByUid: "admin9" });
    assert.equal(record.writtenBy, "destroy");
    assert.equal(record.writtenByUid, "admin9");
  });
});

// ---------------------------------------------------------------------------
// 2. appliedFor: human labels, in the order the applicant meant
// ---------------------------------------------------------------------------

describe("buildApplicationRecord: appliedFor", () => {
  it("names the stream, then the fellowships in RANKED order, then the tick", () => {
    // Position in this list is the applicant's preference order, so the
    // assertion is on the sequence and not on the set. The fixture ranks
    // Interpretability above Governance while the round lists them the other
    // way round, which is the whole point: the round's order must not win.
    const record = build();
    assert.deepEqual(record.appliedFor, [
      "Technical incubator",
      "Interpretability fellowship",
      "Governance fellowship",
      OPEN_TO_FELLOWSHIP_LABEL,
    ]);
  });

  it("never emits a bare id when a programme was removed from the round", () => {
    // An admin edited the options after somebody applied. Dropping the entry
    // would make the record say they ranked one fellowship when they ranked
    // two, so it keeps a sentence in its place.
    const record = build({
      application: application({
        programmePreference: {
          streamId: "s-gone",
          rankedFellowshipIds: ["f-gov"],
          openToFellowship: false,
        },
      }),
    });
    assert.deepEqual(record.appliedFor, [
      REMOVED_PROGRAMME_LABEL,
      "Governance fellowship",
    ]);
    for (const label of record.appliedFor) {
      assert.ok(!label.includes("s-gone"), "no raw id reaches the record");
      assert.ok(!label.startsWith("f-"), "no raw id reaches the record");
    }
  });

  it("is empty when the round asks nothing about programme choice", () => {
    // An appointment round, and any round with the section switched off. The
    // round title is what says what they applied for, and it is stored beside
    // this field for exactly that reason.
    const record = build({
      round: round({
        kind: "appointment",
        label: "Autumn 2026 facilitator appointments",
        programmePreference: {
          enabled: false,
          streams: [],
          fellowships: [],
          maxRankedFellowships: 2,
          offerFellowshipFallback: false,
        },
      }),
    });
    assert.deepEqual(record.appliedFor, []);
    assert.equal(record.roundKind, "appointment");
    assert.equal(record.roundTitle, "Autumn 2026 facilitator appointments");
  });

  it("de-duplicates on the label and caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => `f-${i}`);
    const record = build({
      round: round({
        programmePreference: {
          enabled: true,
          streams: [],
          fellowships: many.map((id) => ({ id, label: "Same name" })),
          maxRankedFellowships: 30,
          offerFellowshipFallback: false,
        },
      }),
      application: application({
        programmePreference: {
          streamId: null,
          rankedFellowshipIds: many,
          openToFellowship: false,
        },
      }),
    });
    assert.deepEqual(record.appliedFor, ["Same name"]);
    assert.ok(record.appliedFor.length <= MEMBER_RECORD_LIMITS.maxAppliedFor);
  });
});

// ---------------------------------------------------------------------------
// 3. The score summary
// ---------------------------------------------------------------------------

describe("buildApplicationRecord: scoreSummary", () => {
  it("counts everyone who assessed them, and means only over those who scored", () => {
    // The trap this pins: an AdmissionReviewDoc's `total` is the sum of its
    // scores map, so a reviewer who wrote notes without scoring has a total of
    // 0. Including them pulls the mean towards zero and reports a worse
    // applicant than the reviewers described.
    const record = build({ reviews: threeReviews() });
    assert.equal(record.scoreSummary.reviewerCount, 3, "all three assessed them");
    assert.equal(record.scoreSummary.total, 14, "9 + 5, the unscored one excluded");
    assert.equal(record.scoreSummary.mean, 7, "14 over two scoring reviewers");
  });

  it("means each criterion over the reviewers who scored THAT criterion", () => {
    const record = build({
      reviews: [
        review("rev-a", { scores: { motivation: 5, fit: 4 }, total: 9 }),
        // Scored motivation only. `fit` must be a mean of one, not of two.
        review("rev-b", { scores: { motivation: 2 }, total: 2 }),
      ],
    });
    assert.deepEqual(record.scoreSummary.byCriterion, { motivation: 3.5, fit: 4 });
  });

  it("keeps a criterion nobody scored as null rather than dropping it", () => {
    // Present-with-null and absent are different facts: "nobody scored this"
    // against "this criterion did not exist on the round".
    const record = build({
      reviews: [review("rev-a", { scores: { motivation: 4 }, total: 4 })],
    });
    assert.deepEqual(record.scoreSummary.byCriterion, { motivation: 4, fit: null });
    assert.ok(Object.hasOwn(record.scoreSummary.byCriterion, "fit"));
  });

  it("reports nulls, not zeroes, when nobody scored at all", () => {
    const record = build({
      reviews: [review("rev-c", { scores: {}, total: 0, notes: "No time." })],
    });
    assert.equal(record.scoreSummary.reviewerCount, 1);
    assert.equal(record.scoreSummary.total, null);
    assert.equal(record.scoreSummary.mean, null);
    assert.deepEqual(record.scoreSummary.byCriterion, { motivation: null, fit: null });
  });

  it("is all nulls and a zero count when nobody reviewed them", () => {
    const record = build({ reviews: [] });
    assert.deepEqual(record.scoreSummary, {
      reviewerCount: 0,
      total: null,
      mean: null,
      byCriterion: { motivation: null, fit: null },
    });
  });

  it("rounds a mean to two places rather than storing IEEE noise", () => {
    // 11 / 3 is 3.6666666666666665 in floating point, and a stored record
    // carrying that reads as false precision about a judgement three people
    // made on a five-point scale.
    const record = build({
      reviews: [
        review("rev-a", { scores: { motivation: 5 }, total: 5 }),
        review("rev-b", { scores: { motivation: 3 }, total: 3 }),
        review("rev-c", { scores: { motivation: 3 }, total: 3 }),
      ],
    });
    assert.equal(record.scoreSummary.mean, 3.67);
    assert.equal(record.scoreSummary.byCriterion.motivation, 3.67);
  });
});

// ---------------------------------------------------------------------------
// 4. The reviewer notes
// ---------------------------------------------------------------------------

describe("buildApplicationRecord: reviewerNotes", () => {
  it("copies the notes verbatim and keeps the reviewers in a stable order", () => {
    // Verbatim because the note is the reviewer's own sentence about a named
    // person and nothing here may paraphrase it. Stable because an entry
    // rewritten later (a settle, then a destroy that finds it stale) must not
    // shuffle its own notes and read as though something changed.
    const record = build({
      reviews: [review("rev-b"), review("rev-a")],
      reviewerNames: { "rev-a": "Ada Reviewer", "rev-b": "Bo Reviewer" },
    });
    assert.deepEqual(
      record.reviewerNotes.map((n) => n.reviewerUid),
      ["rev-a", "rev-b"],
    );
    assert.equal(record.reviewerNotes[0].notes, "Notes from rev-a.");
    assert.equal(record.reviewerNotes[1].notes, "Notes from rev-b.");
  });

  it("names each reviewer, and falls back for one it cannot name", () => {
    // A reviewer who has since deleted their account has no name left to look
    // up. Their assessment is still part of the record, so the entry keeps it
    // under the repo-wide fallback rather than dropping it.
    const record = build({
      reviews: [review("rev-a"), review("rev-gone")],
      reviewerNames: { "rev-a": "  Ada Reviewer  " },
    });
    assert.equal(record.reviewerNotes[0].reviewerName, "Ada Reviewer");
    assert.equal(record.reviewerNotes[1].reviewerName, UNNAMED_REVIEWER);
  });

  it("never writes an email address as a reviewer's name", () => {
    // A real member of this society has a display name that is their email
    // address, so "fall back when the name is missing" is not enough on its
    // own. The entry outlives the round and is read by every SU-recognised
    // committee member; it has no reason to carry a contact address.
    const record = build({
      reviews: [review("rev-a")],
      reviewerNames: { "rev-a": "reviewer@nottingham.ac.uk" },
    });
    assert.equal(record.reviewerNotes[0].reviewerName, UNNAMED_REVIEWER);
    assert.ok(!JSON.stringify(record).includes("@"));
  });

  it("gives an unscored reviewer a null total, never a zero", () => {
    const record = build({ reviews: threeReviews() });
    const byUid = Object.fromEntries(record.reviewerNotes.map((n) => [n.reviewerUid, n]));
    assert.equal(byUid["rev-a"].total, 9);
    assert.equal(byUid["rev-c"].total, null, "not 0: they never scored");
    assert.equal(byUid["rev-c"].recommendation, "hold", "but they did recommend");
    assert.equal(byUid["rev-c"].notes, "Could not get to the scoring, but worth a look.");
  });

  it("drops a review that belongs to a different applicant or round", () => {
    // A safety property, not tidiness. The entry outlives everything it was
    // derived from, so a caller whose query was one clause short must not be
    // able to staple somebody else's assessments onto a named person's record.
    const record = build({
      reviews: [
        review("rev-a"),
        review("rev-x", { applicantUid: "somebody-else" }),
        review("rev-y", { roundId: "spring-2027" }),
      ],
    });
    assert.deepEqual(
      record.reviewerNotes.map((n) => n.reviewerUid),
      ["rev-a"],
    );
    assert.equal(record.scoreSummary.reviewerCount, 1);
  });

  it("keeps a review that names neither, rather than emptying the record", () => {
    // An older row, or a fixture. Dropping it would silently empty a record
    // whose reviews are sitting right there, which is the worse failure.
    const record = build({
      reviews: [review("rev-a", { roundId: "", applicantUid: "" })],
    });
    assert.equal(record.reviewerNotes.length, 1);
  });

  it("caps the notes list and each note's length", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      review(`rev-${String(i).padStart(2, "0")}`, { notes: "x".repeat(9000) }),
    );
    const record = build({ reviews: many });
    assert.equal(record.reviewerNotes.length, MEMBER_RECORD_LIMITS.maxReviewerNotes);
    assert.equal(record.reviewerNotes[0].notes.length, MEMBER_RECORD_LIMITS.notes);
  });

  it("caps the NOTES only: the scores still count every reviewer", () => {
    // The cap is a document-size guard on a list of prose. If it reached the
    // arithmetic as well, an applicant with more reviewers than the cap would be
    // scored over the first twenty in uid order, and the record would report a
    // reviewerCount and a mean that describe a subset nobody chose and no reader
    // could detect. 30 reviewers, each scoring 2 on one criterion: the mean is
    // 2 either way, so the count is what gives it away.
    const many = Array.from({ length: 30 }, (_, i) =>
      review(`rev-${String(i).padStart(2, "0")}`, {
        scores: { motivation: 2 },
        total: 2,
      }),
    );
    const record = build({ reviews: many });
    assert.equal(record.reviewerNotes.length, MEMBER_RECORD_LIMITS.maxReviewerNotes);
    assert.equal(record.scoreSummary.reviewerCount, 30, "every reviewer is counted");
    assert.equal(record.scoreSummary.total, 60, "2 from each of the 30");
    assert.equal(record.scoreSummary.mean, 2);
    assert.equal(record.scoreSummary.byCriterion.motivation, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. normalizeApplicationRecord
// ---------------------------------------------------------------------------

describe("normalizeApplicationRecord", () => {
  it("reads a well-formed entry back unchanged", () => {
    const written = build({ reviews: threeReviews(), reviewerNames: { "rev-a": "Ada" } });
    const read = normalizeApplicationRecord("autumn-2026", {
      ...written,
      writtenAt: new Date("2026-09-21T10:00:00Z"),
    });
    assert.equal(read.id, "autumn-2026");
    assert.equal(read.roundId, written.roundId);
    assert.deepEqual(read.appliedFor, written.appliedFor);
    assert.deepEqual(read.outcome, written.outcome);
    assert.deepEqual(read.scoreSummary, written.scoreSummary);
    assert.deepEqual(read.reviewerNotes, written.reviewerNotes);
    assert.deepEqual(read.writtenAt, new Date("2026-09-21T10:00:00Z"));
  });

  it("falls back to the document id when the roundId field is gone", () => {
    // The doc id IS the round id by construction, so it is the honest fallback
    // rather than a guess.
    const read = normalizeApplicationRecord("autumn-2026", { roundTitle: "Autumn" });
    assert.equal(read.roundId, "autumn-2026");
  });

  it("survives an entry that is entirely the wrong shape", () => {
    const read = normalizeApplicationRecord("r1", {
      roundTitle: 42,
      roundKind: null,
      appliedFor: "not an array",
      appliedAt: "not a timestamp",
      outcome: "not a map",
      scoreSummary: [1, 2, 3],
      reviewerNotes: { nope: true },
      writtenBy: "hand-edited-in-the-console",
      writtenByUid: undefined,
    });
    assert.deepEqual(read, {
      id: "r1",
      roundId: "r1",
      roundTitle: "",
      roundKind: "",
      appliedFor: [],
      appliedAt: null,
      submittedAt: null,
      outcome: { decision: null, status: "", targetRunId: null },
      scoreSummary: { reviewerCount: 0, total: null, mean: null, byCriterion: {} },
      reviewerNotes: [],
      writtenAt: null,
      // An unrecognised writer reads as `backfill`: the only member of the
      // union that does not claim a specific event happened.
      writtenBy: "backfill",
      writtenByUid: "",
    });
  });

  it("keeps an outcome this build cannot name, rather than mapping it onto one it can", () => {
    // The entry is a historical document. A later build that renames a status
    // must not make an old entry claim an outcome that never happened, which
    // is the `courseAudit` normaliser's position for the same reason.
    const read = normalizeApplicationRecord("r1", {
      outcome: { decision: "defer", status: "deferred", targetRunId: "run9" },
    });
    assert.deepEqual(read.outcome, {
      decision: "defer",
      status: "deferred",
      targetRunId: "run9",
    });
  });

  it("keeps a stored null in byCriterion, because the null is the fact", () => {
    const read = normalizeApplicationRecord("r1", {
      scoreSummary: { reviewerCount: 2, total: 6, mean: 3, byCriterion: { a: 3, b: null } },
    });
    assert.deepEqual(read.scoreSummary.byCriterion, { a: 3, b: null });
  });

  it("refuses an email address a stored reviewer name carries", () => {
    // The guard runs on read as well as on write, so a row written before the
    // guard existed cannot put an address on somebody's screen.
    const read = normalizeApplicationRecord("r1", {
      reviewerNotes: [
        { reviewerUid: "rev-a", reviewerName: "rev@example.com", notes: "Fine." },
      ],
    });
    assert.equal(read.reviewerNotes[0].reviewerName, UNNAMED_REVIEWER);
    assert.equal(read.reviewerNotes[0].notes, "Fine.");
    assert.equal(read.reviewerNotes[0].total, null);
  });

  it("drops a reviewer note with no uid, and caps the rest", () => {
    const read = normalizeApplicationRecord("r1", {
      reviewerNotes: [
        { reviewerName: "Nobody", notes: "orphan" },
        ...Array.from({ length: 40 }, (_, i) => ({
          reviewerUid: `rev-${i}`,
          reviewerName: "Someone",
          notes: "ok",
        })),
      ],
    });
    assert.equal(read.reviewerNotes.length, MEMBER_RECORD_LIMITS.maxReviewerNotes);
    assert.ok(read.reviewerNotes.every((n) => n.reviewerUid));
  });

  it("clamps a negative or fractional reviewerCount to a whole non-negative number", () => {
    assert.equal(
      normalizeApplicationRecord("r1", { scoreSummary: { reviewerCount: -4 } })
        .scoreSummary.reviewerCount,
      0,
    );
    assert.equal(
      normalizeApplicationRecord("r1", { scoreSummary: { reviewerCount: 2.9 } })
        .scoreSummary.reviewerCount,
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The source pin: nothing client-side writes the collection
// ---------------------------------------------------------------------------

/** Every file under a directory, recursively. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * The client SDK write calls. These six are the whole surface: there is no other
 * way to write Firestore from a browser.
 *
 * `runTransaction` is in the list because a transaction's own writes go through
 * `txn.set(ref, ...)` and `txn.update(ref, ...)`, which match none of the five
 * function names beside it. A pin that missed the transaction form would wave
 * through exactly the write it exists to catch.
 */
const CLIENT_WRITE =
  /\b(setDoc|updateDoc|deleteDoc|addDoc|writeBatch|runTransaction)\b/;

test("no client surface writes memberRecords", () => {
  const roots = [
    join(REPO_ROOT, "src", "features"),
    join(REPO_ROOT, "src", "app", "(app)"),
  ];
  const offenders = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, "utf8");
      // Both the constant and the literal, because a file that hard-codes the
      // string never imports the constant.
      const namesIt =
        source.includes("MEMBER_RECORDS_COLLECTION") ||
        source.includes(`"${MEMBER_RECORDS_COLLECTION}"`);
      if (!namesIt) continue;
      if (CLIENT_WRITE.test(source)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "`memberRecords` is `allow write: if false` for every client, admins included, " +
      "so a client-direct write here would be refused at runtime on a surface nobody " +
      "tests as a member. Write it from an Admin SDK route with " +
      "upsertApplicationRecord(). Offenders: " +
      offenders.join(", "),
  );
});

test("the collection names are the ones the rules and the routes agree on", () => {
  // A rename here is a silent data split: the routes would write one
  // collection and `firestore.rules` would guard another. The rules file is
  // the second half of the pin.
  assert.equal(MEMBER_RECORDS_COLLECTION, "memberRecords");
  assert.equal(MEMBER_RECORD_APPLICATIONS, "applications");
  const rules = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");
  assert.ok(
    rules.includes("match /memberRecords/{uid} {"),
    "firestore.rules has no block for memberRecords",
  );
  assert.ok(
    rules.includes("match /memberRecords/{uid}/applications/{roundId} {"),
    "firestore.rules has no block for the applications subcollection, which does " +
      "NOT inherit its parent's rules",
  );
});
