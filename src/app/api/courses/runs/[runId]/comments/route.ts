import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { normalizeCourseProgress } from "@/lib/firestore/courseProgress";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * The cohort comment lane for one week — what everyone on the run said about
 * this week's materials, rendered under each material as a disclosure.
 *
 * WHO MAY READ: the same set as the run overview — enrolled members
 * (active or completed) ∪ facilitators ∪ admins. Reviewers and track leads are
 * NOT in it: admissions is a separate lane from the cohort.
 *
 * ── WHY A ROUTE, NOT A CLIENT QUERY ─────────────────────────────────────────
 * `courseProgress` is OWN-ROW read in firestore.rules — a member's list query
 * must constrain `uid == self` or it is denied outright. That is deliberate
 * (see the collection's rules block: keeping the read rule `get()`-free is
 * what makes big own-progress lists cheap), and it means cohort-wide progress
 * can only ever reach a member through this route. Everything below is the
 * scoping the rules can't express.
 *
 * `hasPublicComment` exists FOR this query. Firestore cannot filter on field
 * existence, so `courseProgress.ts` maintains a boolean mirror of "publicComment
 * is set and non-empty" — computed in exactly one place (`buildProgressWrite`)
 * and pinned to the actual comment by the rules, so a row can never lie about
 * it and hide from, or leak into, this lane.
 *
 * MODERATION: rows carrying `moderatedByUid` are dropped here for everyone
 * EXCEPT admins, who receive them flagged `moderated: true` — the week page's
 * hide/unhide control is the moderation route's only caller, and it cannot
 * offer "unhide" for a row it never sees. The comment TEXT stays in Firestore
 * as the audit trail — hiding is not deletion — and the rules pin both
 * moderation fields verbatim on every member write, so a member cannot launder
 * a hidden comment back into this payload by re-saving the row.
 *
 * PII: names via `displayNameOf`, never an email. `privateNote` (facilitators
 * and admins only, by design) is not read here at all — this is the public
 * lane, and adding a branch for it would put a private note one boolean away
 * from the whole cohort.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the cohort-comments disclosure renders from)
// ---------------------------------------------------------------------------

export type WeekCommentsPayload = {
  items: Array<{
    /**
     * The `courseProgress` doc id, VERBATIM. Construct-only, never parsed
     * (`runId` itself can contain the `__` separator) — it travels solely so
     * the admin moderation route can address this row.
     */
    progressId: string;
    /** The material / checklist item the comment hangs off. */
    itemId: string;
    uid: string;
    displayName: string;
    rating: number | null;
    /** Member-authored plain text — rendered as a text node, never as HTML. */
    comment: string;
    /** ISO 8601, or null on a row with no `updatedAt`. */
    updatedAt: string | null;
    /**
     * Present, and only ever `true`, on a row a moderator has hidden. ADMIN
     * PAYLOADS ONLY: every other caller has hidden rows filtered out entirely,
     * so an absent flag means "not hidden from you", never "not hidden".
     */
    moderated?: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/**
 * A whole cohort's comments for one week: ~100 members × ~10 commented items
 * is the shape this is sized for. The cap is a cost ceiling on a runaway run,
 * not a paging scheme — a cohort that reaches it needs a paged lane.
 */
const MAX_COMMENT_ROWS = 500;

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for a cohort-wide payload. (Same local helper P1/P5/P6 carry; route handlers
 * don't import from one another, so it is duplicated on purpose.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** `?week=N` — a positive integer inside the plan's bounds, or null. */
function parseWeek(raw: string | null): number | null {
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_WEEK_NUMBER ? n : null;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const week = parseWeek(new URL(req.url).searchParams.get("week"));
  if (week === null) {
    return NextResponse.json(
      { error: `week must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }

  // Access needs exactly two docs. Group-level facilitation is deliberately
  // NOT resolved from `courseGroups` here the way the overview route resolves
  // it: the facilitators route leaves an existing LEARNER enrolment alone
  // (flipping its role would discard the placement — see runAccess.ts), so
  // someone who both learns on this run and facilitates a group of it arrives
  // with a learner enrolment, which passes the check below on its own.
  // The uncovered case is narrow and fails CLOSED: a facilitator whose
  // enrolment has been withdrawn or removed while they still hold a group
  // reads the run home but gets 403 here. Widening it costs a query on a lane
  // that is fetched per week page; it is a deliberate trade, not an oversight.
  const [runSnap, enrolSnap] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, actor.uid)).get(),
  ]);

  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const enrolment = enrolSnap.exists
    ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
    : null;
  const liveEnrolment =
    enrolment && (enrolment.status === "active" || enrolment.status === "completed")
      ? enrolment
      : null;
  const isFacilitator =
    (liveEnrolment?.role === "facilitator" && liveEnrolment.status === "active") ||
    run.runFacilitatorUids.includes(actor.uid);
  const isAdmin = actor.role === "admin";

  if (!isAdmin && !liveEnrolment && !isFacilitator) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The week number is the CLIENT's here, but it addresses nothing beyond this
  // run's own rows — cohort scoping is the `runId` equality, which comes from
  // the path and is what the access check above was made against. Served by the
  // (runId, weekNumber, hasPublicComment) composite index.
  const snap = await db
    .collection("courseProgress")
    .where("runId", "==", runId)
    .where("weekNumber", "==", week)
    .where("hasPublicComment", "==", true)
    .limit(MAX_COMMENT_ROWS)
    .get();

  const rows = snap.docs
    .map((d) => normalizeCourseProgress(d.id, d.data() ?? {}))
    // Moderated rows travel to ADMINS ONLY (flagged below — they are what the
    // hide/unhide control acts on). `publicComment` can still be absent on a
    // row whose mirror drifted (a pre-rules write, say) — such a row has
    // nothing to show, so it is dropped rather than rendered blank.
    .filter((p) => p.publicComment && (isAdmin || !p.moderatedByUid));

  const uids = [...new Set(rows.map((p) => p.uid).filter(Boolean))];
  const userDocs = uids.length
    ? await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  const items: WeekCommentsPayload["items"] = rows
    .map((p) => ({
      progressId: p.id,
      itemId: p.itemId,
      uid: p.uid,
      displayName: nameByUid.get(p.uid) ?? "NAISI member",
      rating: p.rating ?? null,
      comment: p.publicComment ?? "",
      updatedAt: iso(p.updatedAt),
      // Set only on rows only admins reach (the filter above), so no
      // non-admin surface can key off a `false` that would mean "visible".
      ...(p.moderatedByUid ? { moderated: true as const } : {}),
    }))
    // Newest first; a row with no `updatedAt` sorts last rather than first.
    .sort(
      (a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
        a.displayName.localeCompare(b.displayName),
    );

  const payload: WeekCommentsPayload = { items };
  return NextResponse.json(payload);
}
