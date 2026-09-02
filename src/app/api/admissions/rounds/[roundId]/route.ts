import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  REMINDER_OFFSET_IDS,
  normalizeAdmissionRound,
  normalizeAdmissionStage,
  type AdmissionCriterion,
  type ProgrammeOption,
  type ReminderOffset,
  type ReminderOffsetId,
  type RoundProgrammePreference,
} from "@/lib/firestore/admissionRounds";
import { isUsableGrid, normalizeAvailabilityGrid } from "@/lib/admissions/availability";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import { ACADEMIC_YEAR_PATTERN } from "@/lib/firestore/users";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  canSeeRound,
  parseInstant,
  parseWallClock,
  serialiseRound,
  serialiseStage,
} from "@/lib/admissions/roundRoutes";

/**
 * One round: read it, and edit everything about it EXCEPT the three things
 * that belong to their own routes.
 *
 * ## What this route deliberately cannot write
 *
 *  - `status`, which is a machine with a transition table
 *    (`POST .../status`). A PATCH that could set it would be that table's
 *    second, unenforced door.
 *  - `reviewerUids` and `finalDeciderUid` (`PUT .../roles`). Appointing a
 *    reviewer also writes the server-owned `users.admissionsReviewer` flag on
 *    the people involved, so it is admin-only and transactional; folding it
 *    into the general editor PATCH would put a user-document write behind
 *    every save of a blurb.
 *  - `stageIds` and everything under `stages` (`PUT .../stages/[stageId]`).
 *  - `applicationCounts`, which only the apply and decide routes move.
 *
 * A body naming any of them is refused rather than ignored, because a console
 * that thinks it saved a reviewer list and a server that quietly dropped it is
 * the failure that surfaces on decision day.
 *
 * ## The submitted-applications freeze
 *
 * Once anyone has SUBMITTED, `criteria` and `programmePreference` are frozen
 * behind an explicit `force`. Both are retrospective: criteria are what every
 * existing review was scored against, so renaming one silently relabels
 * decisions already made, and dropping one orphans the scores stored under its
 * id. Programme preference is worse, because an applicant answered it: pulling
 * a fellowship option out from under a submitted ranking leaves a stored
 * preference for something the round no longer offers.
 *
 * Neither is forbidden outright, because a typo in a criterion label two hours
 * into a window is a real thing that happens. It is forced, with a typed
 * confirmation on the client, so it is a decision somebody made rather than a
 * side effect of pressing save.
 *
 * ## What an appointment round cannot have
 *
 * The facilitator intake is a round of kind `appointment`: it appoints people
 * to run a group rather than placing them on one. Two sections of the document
 * therefore have nothing legitimate to hold on it, and both are REFUSED with a
 * sentence rather than normalised away:
 *
 *  - `outcomeRunIds`, because the decide route has no seat to mint and would be
 *    reading a target nobody meant.
 *  - `programmePreference`, because the apply flow renders no programme section
 *    for this kind, so anything stored here is an answer to a question no
 *    applicant was ever shown.
 *
 * Refusing is what makes the apply flow's kind check and this route agree. A
 * quiet normalise would leave the console showing a section it had apparently
 * saved, which is the same class of failure as the dropped reviewer list.
 */

const L = ADMISSION_ROUND_FIELD_LIMITS;

/**
 * Fields fixed when the round is created.
 *
 * `kind` decides which half of this route's own validation a body is held to,
 * which sections the console draws and which form an applicant is shown, and
 * an appointment round that had already collected facilitator applications
 * would answer none of those questions the same way after a flip. There is no
 * migration behind such a change and no honest one to write, so the kind is
 * chosen once, on the create form, and refused here rather than ignored: a
 * console that believed it changed the kind and a server that dropped the key
 * is the failure nobody notices until an applicant is looking at the wrong
 * form.
 */
const IMMUTABLE_FIELDS = ["kind"];

/** Fields that exist on the document but are written elsewhere. */
const FOREIGN_FIELDS = [
  "status",
  "reviewerUids",
  "finalDeciderUid",
  "stageIds",
  "applicationCounts",
  "authorUid",
  "clonedFromRoundId",
  "createdAt",
  "updatedAt",
];

type Body = Record<string, unknown>;

class BadRequest extends Error {}

function bad(message: string): never {
  throw new BadRequest(message);
}

function readString(raw: unknown, field: string, max: number, required = false): string {
  if (typeof raw !== "string") bad(`${field} must be text.`);
  const value = raw.trim();
  if (required && !value) bad(`${field} cannot be empty.`);
  if (value.length > max) {
    bad(`${field} is ${value.length - max} character${value.length - max === 1 ? "" : "s"} over its limit of ${max}.`);
  }
  return value;
}

function readInt(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    bad(`${field} must be a whole number.`);
  }
  if (raw < min || raw > max) bad(`${field} must be between ${min} and ${max}.`);
  return raw;
}

function readBool(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") bad(`${field} must be true or false.`);
  return raw;
}

function readIdList(raw: unknown, field: string, cap: number): string[] {
  if (!Array.isArray(raw)) bad(`${field} must be a list.`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) bad(`${field} contains an empty entry.`);
    const value = item.trim();
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > cap) bad(`${field} takes at most ${cap} entries.`);
  return out;
}

function readOptions(raw: unknown, field: string): ProgrammeOption[] {
  if (!Array.isArray(raw)) bad(`${field} must be a list.`);
  if (raw.length > L.maxProgrammeOptions) {
    bad(`${field} takes at most ${L.maxProgrammeOptions} choices.`);
  }
  const out: ProgrammeOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") bad(`${field} contains an entry that is not a choice.`);
    const o = item as Body;
    const id = readString(o.id, `A choice in ${field}`, 60, true);
    if (seen.has(id)) bad(`${field} lists the same choice twice.`);
    seen.add(id);
    out.push({ id, label: readString(o.label, `A choice label in ${field}`, L.programmeOptionLabel, true) });
  }
  return out;
}

function readProgrammePreference(raw: unknown): RoundProgrammePreference {
  if (!raw || typeof raw !== "object") bad("Programme preference must be an object.");
  const p = raw as Body;
  return {
    enabled: readBool(p.enabled, "Programme preference"),
    streams: readOptions(p.streams, "the incubator streams"),
    fellowships: readOptions(p.fellowships, "the fellowships"),
    maxRankedFellowships: readInt(
      p.maxRankedFellowships,
      "The number of fellowships an applicant may rank",
      1,
      L.maxProgrammeOptions,
    ),
    offerFellowshipFallback: readBool(
      p.offerFellowshipFallback,
      "The fellowship fallback question",
    ),
  };
}

function readCriteria(raw: unknown): AdmissionCriterion[] {
  if (!Array.isArray(raw)) bad("Criteria must be a list.");
  if (raw.length > L.maxCriteria) bad(`A round takes at most ${L.maxCriteria} criteria.`);
  const out: AdmissionCriterion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") bad("A criterion is not an object.");
    const c = item as Body;
    const id = readString(c.id, "A criterion id", 60, true);
    if (seen.has(id)) {
      // Reviews key their scores on this id, so two criteria sharing one would
      // make a score ambiguous rather than merely duplicated on screen.
      bad("Two criteria share an id. Each one needs its own.");
    }
    seen.add(id);
    out.push({
      id,
      label: readString(c.label, "A criterion needs a name, and it", L.criterionLabel, true),
      guidance: readString(c.guidance ?? "", "Criterion guidance", L.criterionGuidance),
    });
  }
  return out;
}

function readReminderOffsets(raw: unknown): ReminderOffset[] {
  if (!Array.isArray(raw)) bad("The reminder schedule must be a list.");
  if (raw.length > L.maxReminderOffsets) {
    bad(`A round takes at most ${L.maxReminderOffsets} reminders.`);
  }
  const out: ReminderOffset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") bad("A reminder is not an object.");
    const o = item as Body;
    const id = o.id as ReminderOffsetId;
    if (!REMINDER_OFFSET_IDS.includes(id)) bad("That is not a reminder this site sends.");
    if (seen.has(id)) bad("The same reminder is listed twice.");
    seen.add(id);
    const atLocalTime = parseWallClock(o.atLocalTime);
    if (!atLocalTime) bad("A reminder time must look like 10:00.");
    out.push({
      id,
      daysBefore: readInt(o.daysBefore, "A reminder's days-before", 0, 60),
      atLocalTime,
    });
  }
  return out;
}

/** Stable comparison for the two frozen sections. Field order is ours, not the client's. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const ref = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Round not found" }, { status: 404 });

  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});
  if (!canSeeRound(user, round)) {
    // 404 rather than 403: whether a round exists is itself information about
    // an intake, and a caller who cannot see it has no use for the difference.
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }

  const canAuthor = canAuthorRounds(user);
  const stagesSnap = await ref.collection(STAGES_SUBCOLLECTION).get();
  const stages = stagesSnap.docs
    .map((d) => normalizeAdmissionStage(d.id, d.data() ?? {}))
    .sort((a, b) => a.order - b.order);

  return NextResponse.json({
    round: serialiseRound(round),
    // Question text is the timed-release guarantee. An author is the person
    // writing it; nobody else on this route gets it, and the count is enough
    // for every other surface here.
    stages: stages.map((s) => serialiseStage(s, canAuthor)),
    canAuthor,
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canAuthorRounds(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const immutable = IMMUTABLE_FIELDS.filter((f) => f in body);
  if (immutable.length > 0) {
    return NextResponse.json(
      {
        error:
          "A round's kind is fixed when it is created. Create a new round if you need the other one.",
      },
      { status: 400 },
    );
  }

  const foreign = FOREIGN_FIELDS.filter((f) => f in body);
  if (foreign.length > 0) {
    return NextResponse.json(
      {
        error: `${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} written by another route and cannot be saved here.`,
      },
      { status: 400 },
    );
  }

  const ref = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Round not found" }, { status: 404 });
  const current = normalizeAdmissionRound(snap.id, snap.data() ?? {});

  const update: Record<string, unknown> = {};
  try {
    if ("label" in body) update.label = readString(body.label, "The round name", L.label, true);
    if ("slug" in body) {
      const slug = readString(body.slug, "The url segment", L.slug, true);
      if (!/^[a-z0-9-]+$/.test(slug)) {
        bad("The url segment can use lowercase letters, numbers and hyphens only.");
      }
      update.slug = slug;
    }
    if ("blurb" in body) update.blurb = readString(body.blurb, "The standfirst", L.blurb);
    if ("academicYear" in body) {
      const year = readString(body.academicYear, "The academic year", L.academicYear);
      if (year && !ACADEMIC_YEAR_PATTERN.test(year)) {
        bad("The academic year looks like 2026/27.");
      }
      update.academicYear = year;
    }
    if ("accessRequirementsPrompt" in body) {
      update.accessRequirementsPrompt = readString(
        body.accessRequirementsPrompt,
        "The access-requirements question",
        L.accessRequirementsPrompt,
      );
    }
    if ("archived" in body) update.archived = readBool(body.archived, "Archived");

    let opensAt = current.opensAt;
    let closesAt = current.closesAt;
    if ("opensAt" in body) {
      const parsed = parseInstant(body.opensAt, "The opening date");
      if (!parsed.ok) bad(parsed.error);
      opensAt = parsed.value;
      update.opensAt = parsed.value;
    }
    if ("closesAt" in body) {
      const parsed = parseInstant(body.closesAt, "The deadline");
      if (!parsed.ok) bad(parsed.error);
      closesAt = parsed.value;
      update.closesAt = parsed.value;
    }
    if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
      bad("The deadline has to be after the opening date.");
    }

    if ("decisionsByDate" in body) {
      const raw = body.decisionsByDate;
      if (raw === null || raw === "") {
        update.decisionsByDate = null;
      } else if (typeof raw === "string" && isValidDateKey(raw)) {
        update.decisionsByDate = raw;
      } else {
        // `isValidDateKey` round-trips, so 2026-02-31 is caught here rather
        // than rolling silently into March on the page that promises a date.
        bad("The decisions date must be a real calendar date.");
      }
    }

    if ("availabilityGrid" in body) {
      const grid = normalizeAvailabilityGrid(body.availabilityGrid);
      if (!isUsableGrid(grid)) bad("That availability grid has no slots in it.");
      update.availabilityGrid = grid;
    }

    if ("scoreScale" in body) {
      const raw = (body.scoreScale ?? {}) as Body;
      const min = readInt(raw.min, "The lowest score", L.minScore, L.maxScore);
      const max = readInt(raw.max, "The highest score", L.minScore, L.maxScore);
      if (max <= min) bad("The highest score has to be above the lowest.");
      update.scoreScale = { min, max };
    }

    if ("reviewersPerApplication" in body) {
      update.reviewersPerApplication = readInt(
        body.reviewersPerApplication,
        "Reviewers per application",
        1,
        L.maxReviewers,
      );
    }

    if ("blind" in body) {
      const raw = (body.blind ?? {}) as Body;
      update.blind = {
        hideNames: readBool(raw.hideNames, "Hide names"),
        hideMembership: readBool(raw.hideMembership, "Hide the membership badge"),
      };
    }

    if ("evidenceRunIds" in body) {
      update.evidenceRunIds = readIdList(
        body.evidenceRunIds,
        "The evidence runs",
        L.maxEvidenceRuns,
      );
    }

    if ("reminderOffsets" in body) {
      update.reminderOffsets = readReminderOffsets(body.reminderOffsets);
    }

    let outcomeRunIds = current.outcomeRunIds;
    if ("outcomeRunIds" in body) {
      outcomeRunIds = readIdList(body.outcomeRunIds, "The outcome runs", L.maxOutcomeRuns);
      if (current.kind === "appointment" && outcomeRunIds.length > 0) {
        // An appointment round appoints somebody to a job. It places nobody on
        // a run, so an outcome run here would be a target the decide route
        // could never legitimately use.
        bad("An appointment round does not place people on a course run.");
      }
      update.outcomeRunIds = outcomeRunIds;
    }

    if ("programmePreference" in body) {
      const preference = readProgrammePreference(body.programmePreference);
      // The companion refusal to the outcome-runs one above, and it is a
      // refusal rather than a silent normalise for the same reason: an
      // appointment round asks somebody to run a group, not to pick which
      // programme they would like a place on. The apply flow renders no
      // programme section for this kind, so a preference stored here would be
      // a question no applicant was ever asked, sitting on the document the
      // decide route reads.
      //
      // It reads the value FIRST and refuses only a preference that actually
      // asks something, exactly as the outcome-runs refusal above only fires
      // on a non-empty list. A round authored before this kind existed can
      // carry a stored preference, and an unconditional refusal here would
      // leave it with no way back: the one save that clears it, an empty
      // preference, would be the save that is turned away.
      const asksSomething =
        preference.enabled
        || preference.streams.length > 0
        || preference.fellowships.length > 0;
      if (current.kind === "appointment" && asksSomething) {
        bad("An appointment round does not ask applicants to choose a programme.");
      }
      update.programmePreference = preference;
    }

    /**
     * Fellowship choices ARE runs: the option id is the run id, so the decide
     * route can offer a fellowship place without a second lookup table nobody
     * would remember to keep in step.
     *
     * So the pair has to agree, and the check is ONE check over the MERGED
     * pair rather than one hung off the programme section. The console saves a
     * section at a time: taking a run out of the outcomes section sends
     * `outcomeRunIds` with no `programmePreference` beside it, and a check
     * that only ran when the preference was in the body would let that save
     * through and leave a fellowship choice pointing at a run this round can
     * no longer place onto. That is the same orphan, discovered on decision
     * day instead of now.
     */
    if ("outcomeRunIds" in body || "programmePreference" in body) {
      const preference = (
        "programmePreference" in update
          ? update.programmePreference
          : current.programmePreference
      ) as RoundProgrammePreference;
      const stray = preference.fellowships.find((f) => !outcomeRunIds.includes(f.id));
      if (stray) {
        bad(
          "programmePreference" in body
            ? `"${stray.label}" is not one of this round's outcome runs. Add the run to the outcomes section first.`
            : `"${stray.label}" is offered as a fellowship on this round, and the run behind it is not in the outcomes you are saving. Put that run back, or take the choice out of the programme section first.`,
        );
      }
    }

    if ("criteria" in body) update.criteria = readCriteria(body.criteria);
  } catch (err) {
    if (err instanceof BadRequest) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  // The freeze. Only a REAL change trips it: a console that saves a whole
  // section every time must not be told to force a save that changes nothing.
  const submitted = current.applicationCounts.submitted ?? 0;
  if (submitted > 0 && body.force !== true) {
    const frozen: string[] = [];
    if ("criteria" in update && !same(update.criteria, current.criteria)) {
      frozen.push("the criteria reviewers score against");
    }
    if (
      "programmePreference" in update
      && !same(update.programmePreference, current.programmePreference)
    ) {
      frozen.push("the programme choices applicants have already answered");
    }
    if (frozen.length > 0) {
      return NextResponse.json(
        {
          error: `${submitted} application${submitted === 1 ? " has" : "s have"} already been submitted, so changing ${frozen.join(" and ")} would rewrite what those people were asked and judged on. Confirm the change if you are sure.`,
          needsForce: true,
          frozen,
        },
        { status: 409 },
      );
    }
  }

  update.updatedAt = FieldValue.serverTimestamp();
  await ref.update(update);

  const after = await ref.get();
  return NextResponse.json({
    round: serialiseRound(normalizeAdmissionRound(after.id, after.data() ?? {})),
  });
}
