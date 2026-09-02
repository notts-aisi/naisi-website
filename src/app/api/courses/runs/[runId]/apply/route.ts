import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { sendCourseApplicationEmail } from "@/lib/email/courseApplicationEmails";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import { applicationWindow, formatRunStart } from "@/lib/courses/window";
import {
  APPLICATION_FIELD_LIMITS,
  buildApplication,
  courseApplicationId,
  validateApplicationInput,
  type CourseApplicationStatus,
} from "@/lib/firestore/courseApplications";
import {
  normalizeCourseGroup,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import { normalizeCourseRun, type CourseRunDoc } from "@/lib/firestore/courses";
import type { RsvpAnswer } from "@/lib/firestore/events";
import { hasPaidMembership, normalizeUser } from "@/lib/firestore/users";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import {
  DEFAULT_PAUSED_MESSAGE,
  DEFAULT_SITE_NOTICE,
  SITE_NOTICE_PATH,
  isSurfacePaused,
  normaliseSiteNotice,
} from "@/lib/siteNotice";

/**
 * Course run application write API. ALL `courseApplications` writes go through
 * server routes (`allow write: if false` in rules) — the doc carries
 * server-sourced PII (the applicant's email), a paid-membership snapshot, and
 * reviewer-owned decision fields, and the run's status counters have to move in
 * the same transaction. This route is the applicant's third of that surface:
 *
 *   POST   — apply to this run (one per account, structurally)
 *   PATCH  — edit your own application while it is still `pending`
 *   DELETE — withdraw it (soft: the row is kept for audit)
 *
 * Reviewer/admin actions (decide, notes) live under
 * /api/courses/runs/[runId]/applications/… (P5).
 *
 * WHO MAY APPLY (locked product decision): any signed-in user EXCEPT a
 * `rejected` account — `pending` users included. That is deliberate and it is
 * why the apply page lives in the `(public)` route group: `(app)/layout.tsx`
 * bounces `pending` users, so an authed-area page could never host this form.
 *
 * The paid-membership tag is snapshotted here as a BADGE for reviewers. No
 * branch in this file (or any other route) may read it as a gate.
 *
 * Shape borrowed wholesale from /api/collaborators/route.ts: session first,
 * rate limits before any datastore work, a deterministic doc id + `.create()`
 * instead of a uniqueness query, a short `updatedAt`-derived edit cooldown, and
 * enumeration-safe error copy.
 */

// Per-uid write-spam cooldown on edits, read off the doc's own `updatedAt` (no
// extra field). Editing your one application can't grow the collection, so this
// only needs to break a tight rewrite loop — collaborators' precedent verbatim.
const EDIT_COOLDOWN_SECONDS = 10;

// Abuse throttle on application creation (see lib/rateLimit). Generous per-IP
// for shared campus NAT; tighter per-account.
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_IP_MAX = 30;
const RL_UID_MAX = 5;

/**
 * Cap on how many weekly slots an applicant may tick. Availability chips are
 * generated from the run's groups, so a payload longer than this is hand-made,
 * not a form submission.
 */
const MAX_AVAILABILITY_CHOICES = 20;

type Db = NonNullable<ReturnType<typeof getAdminDb>>;

class ApplyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * WIRE vs STORED, deliberately different:
 *
 * The apply form posts `availability: string[]` — the PII-free weekly session
 * labels ("Tuesdays 18:00–19:30") that `getApplyContext()` renders as chips,
 * one per group. The stored `CourseApplicationDoc.availability` is the free
 * text field P0 defined, so the labels the applicant ticked are joined into one
 * line. Reviewers (P5) then read a single sentence rather than a JSON array,
 * and no route has to keep an array of labels in step with groups that get
 * renamed, merged, or deleted mid-cycle.
 *
 * Unknown entries are DROPPED rather than 400'd: the label is a formatted
 * string produced independently on the read path, so a cosmetic formatting
 * change would otherwise start rejecting honest submissions. To keep that
 * tolerance from silently eating every chip, matching is done on a normalised
 * key (case, whitespace and dash-flavour insensitive) and the SERVER's own
 * label is what gets stored.
 */
const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

function addMinutesToHhmm(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * "Tuesdays 18:00–19:30" — the exact contract `getApplyContext()` renders as
 * chips. En dash, matching the rest of the site's ranges. A group with no slot
 * set yet has no label and simply offers no chip.
 */
function sessionLabel(session: GroupSession): string {
  if (!session.startTimeLocal) return "";
  const day = WEEKDAY_PLURALS[session.weekday] ?? "";
  if (!day) return "";
  const end =
    session.durationMinutes > 0
      ? addMinutesToHhmm(session.startTimeLocal, session.durationMinutes)
      : "";
  return end
    ? `${day} ${session.startTimeLocal}–${end}`
    : `${day} ${session.startTimeLocal}`;
}

/**
 * The matching key for a session label: everything that could plausibly drift
 * between the read path's formatter and this one is normalised away — case,
 * whitespace, dash flavour, spacing around the dash, and a plural weekday
 * ("Tuesdays" ≡ "Tuesday"). What is left is the day and the two clock times,
 * which is the actual content of the chip.
 */
function availabilityKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    // Any dash flavour (hyphen, en/em dash, minus sign) compares equal…
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    // …however it is spaced.
    .replace(/\s*-\s*/g, "-")
    .replace(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/, "$1");
}

/** The run's offerable session labels, server-side. Archived groups excluded. */
async function loadSessionLabels(db: Db, runId: string): Promise<string[]> {
  const snap = await db.collection("courseGroups").where("runId", "==", runId).get();
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const doc of snap.docs) {
    const group = normalizeCourseGroup(doc.id, doc.data());
    if (group.archived) continue;
    const label = sessionLabel(group.session);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * Coerce the posted availability into the run's own labels. Returns the error
 * string for a structurally invalid payload (wrong type, or absurdly long);
 * unrecognised entries are dropped, per the module note above.
 */
function resolveAvailability(
  raw: unknown,
  labels: string[],
): { chosen: string[] } | { error: string } {
  if (raw === undefined || raw === null) return { chosen: [] };
  if (!Array.isArray(raw)) return { error: "Availability looks malformed." };
  if (raw.length > MAX_AVAILABILITY_CHOICES) {
    return { error: "That's more availability options than this run offers." };
  }
  const byKey = new Map(labels.map((l) => [availabilityKey(l), l]));
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const match = byKey.get(availabilityKey(entry));
    if (!match || seen.has(match)) continue;
    seen.add(match);
    chosen.push(match);
  }
  return { chosen };
}

/** Join the ticked labels into the stored free-text line, inside its budget. */
function joinAvailability(chosen: string[]): string {
  let out = "";
  for (const label of chosen) {
    const next = out ? `${out}, ${label}` : label;
    if (next.length > APPLICATION_FIELD_LIMITS.availability) break;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run + notice
// ---------------------------------------------------------------------------

async function loadRun(db: Db, runId: string): Promise<CourseRunDoc | null> {
  const snap = await db.collection("courseRuns").doc(runId).get();
  if (!snap.exists) return null;
  return normalizeCourseRun(snap.id, snap.data() ?? {});
}

/**
 * The application window, translated into the applicant's sentence.
 *
 * The PREDICATE lives in `lib/courses/window.ts` and nowhere else. That is
 * the whole point: this route used to own the only date check on the site,
 * while the catalogue, the course page CTA and the apply page all keyed on
 * `status === "applications-open"` alone. A run left open past its deadline
 * therefore advertised an open application, rendered the whole form, and
 * refused the POST after the applicant had written it. Discovery and submit
 * now read the same three lines of arithmetic and cannot disagree again.
 *
 * An `inactive` run (a draft, or an ARCHIVED one) refuses applications with
 * the same sentence as a run that was never open, deliberately: archiving is
 * a withdrawal, and the destroy cascade sets that flag before it deletes
 * anything, so this is also what stops an application landing on a run whose
 * rows are being deleted. The copy does not distinguish the two, because an
 * applicant has no business learning which.
 */
function windowError(run: CourseRunDoc, now: Date): string | null {
  const { state } = applicationWindow(run, now);
  if (state === "open") return null;
  if (state === "not-yet") return "Applications for this run haven't opened yet.";
  if (state === "closed") return "Applications for this run have closed.";
  return "This course run isn't accepting applications.";
}

/**
 * The same predicate, asked the EDIT question.
 *
 * Owner decision D5: once the window is closed an applicant may still VIEW
 * their application, and withdraw it, but no longer edit it. Editing after the
 * deadline meant the version the admissions team read could change under them
 * mid-review, and there was nothing on either side saying when that stopped.
 * Now the deadline says it.
 *
 * `PATCH` is the only lane this closes. `DELETE` is untouched: trapping
 * someone in a queue with no self-service exit helps nobody, and a withdrawal
 * takes work off the team rather than changing it underneath them.
 */
function editWindowError(run: CourseRunDoc, now: Date): string | null {
  const { state } = applicationWindow(run, now);
  if (state === "open") return null;
  if (state === "closed") {
    return "Applications for this run have closed, so this one can't be edited now. It's still in the queue, and you can withdraw it if your plans have changed.";
  }
  if (state === "not-yet") {
    return "Applications for this run aren't open yet, so this one can't be edited right now.";
  }
  return "This course run isn't accepting changes to applications.";
}

/**
 * Server-side read of the maintenance notice, normalised with the same shared
 * helper the banner and every client surface use — so a paused surface reads
 * identically wherever it is checked, and cannot diverge.
 *
 * FAIL-OPEN, matching `siteNotice.ts`'s load-bearing guarantee: an unreadable
 * or malformed doc degrades to "notice off". Blocking applications because the
 * notice doc could not be read would be an outage caused by the outage banner.
 *
 * This route sits under /api/courses/, never /api/admin/ — nothing in the
 * admin tree may be gated on the notice (tests/no-admin-gating.test.mjs).
 */
async function readSiteNotice(db: Db) {
  try {
    const snap = await db
      .collection(SITE_NOTICE_PATH.collection)
      .doc(SITE_NOTICE_PATH.doc)
      .get();
    return normaliseSiteNotice(snap.exists ? snap.data() : null, new Date());
  } catch {
    return DEFAULT_SITE_NOTICE;
  }
}

// ---------------------------------------------------------------------------
// Applicant identity
// ---------------------------------------------------------------------------

type Applicant = {
  displayName: string;
  paidMembershipAtApply: boolean;
};

/**
 * Denormalised name + the paid-membership badge snapshot, read from the user
 * doc. `preferredName` wins over `displayName` — it is what the member asked
 * to be called, and it is the name a reviewer sees in the queue. A missing
 * user doc (dev bypass, a half-finished registration) degrades to the session
 * name rather than failing the application.
 */
async function loadApplicant(db: Db, user: SessionUser): Promise<Applicant> {
  try {
    const snap = await db.collection("users").doc(user.uid).get();
    if (snap.exists) {
      const doc = normalizeUser(snap.id, snap.data() ?? {});
      const displayName =
        doc.profile?.preferredName?.trim() ||
        doc.displayName?.trim() ||
        user.displayName?.trim() ||
        "";
      return { displayName, paidMembershipAtApply: hasPaidMembership(doc) };
    }
  } catch (err) {
    console.warn("[courses apply] user doc read failed", user.uid, err);
  }
  return {
    displayName: user.displayName?.trim() ?? "",
    paidMembershipAtApply: false,
  };
}

// ---------------------------------------------------------------------------
// Shared request prologue
// ---------------------------------------------------------------------------

type Caller = { user: SessionUser; db: Db };

/**
 * Session + Admin SDK, or the response to return. `rejected` accounts are the
 * only signed-in users turned away — see the module comment for why `pending`
 * is deliberately allowed through.
 */
async function requireApplicant(): Promise<Caller | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (user.role === "rejected") {
    return NextResponse.json(
      { error: "This account can't apply for courses." },
      { status: 403 },
    );
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }
  return { user, db };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validate the applicant-supplied half of the payload against the run: the
 * form answers (events' `validateAnswers`, verbatim — the run's
 * `applicationForm` IS a `FormQuestion[]`) and the availability chips.
 */
async function validatePayload(
  db: Db,
  run: CourseRunDoc,
  body: Record<string, unknown>,
): Promise<
  { answers: Record<string, RsvpAnswer>; availability: string } | { error: string }
> {
  const validated = validateAnswers(run.applicationForm, body.answers);
  if ("error" in validated) return { error: validated.error };

  const labels = await loadSessionLabels(db, run.id);
  const resolved = resolveAvailability(body.availability, labels);
  if ("error" in resolved) return { error: resolved.error };
  const availability = joinAvailability(resolved.chosen);

  // The shared P0 validator, run on the composed value so the client form and
  // this route can never disagree about the budget. `facilitatorPreferenceUids`
  // is always empty: applicants deliberately do NOT pick facilitators —
  // admissions records preferences later (P5), which is the only writer of that
  // field.
  const inputError = validateApplicationInput({
    availability,
    facilitatorPreferenceUids: [],
  });
  if (inputError) return { error: inputError };

  return { answers: validated.answers, availability };
}

// ---------------------------------------------------------------------------
// POST — apply
// ---------------------------------------------------------------------------

export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  // Abuse throttle before any datastore work — the point of throttling this
  // route is to cap cost, so it has to come before the reads it protects.
  const ip = clientIp(req);
  const ipLimit = rateLimit(`courses:apply:ip:${ip}`, RL_IP_MAX, RL_WINDOW_MS);
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
    );
  }
  const uidLimit = rateLimit(`courses:apply:uid:${user.uid}`, RL_UID_MAX, RL_WINDOW_MS);
  if (!uidLimit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(uidLimit.retryAfterSeconds) } },
    );
  }

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const run = await loadRun(db, runId);
  if (!run) {
    return NextResponse.json({ error: "Course run not found." }, { status: 404 });
  }

  const openError = windowError(run, new Date());
  if (openError) {
    return NextResponse.json({ error: openError }, { status: 400 });
  }

  const notice = await readSiteNotice(db);
  if (isSurfacePaused(notice, "courseApplications")) {
    return NextResponse.json(
      { error: notice.bannerMessage || DEFAULT_PAUSED_MESSAGE },
      { status: 503 },
    );
  }

  // `applicationCap` is SOFT and is deliberately NOT checked here — the run
  // editor calls it a "Soft cap on accepted applicants", i.e. a target for
  // admissions, not a door. Turning applicants away automatically would hand a
  // capacity decision to whoever refreshes fastest; the queue is reviewed by
  // people, and a waitlist status already exists for the overflow.

  const payload = await validatePayload(db, run, body);
  if ("error" in payload) {
    return NextResponse.json({ error: payload.error }, { status: 400 });
  }

  const applicant = await loadApplicant(db, user);

  const doc = buildApplication(
    {
      runId,
      courseId: run.courseId,
      uid: user.uid,
      // From the SESSION, never the body — an applicant must not be able to
      // plant someone else's address on a doc reviewers will email.
      email: user.email,
      displayName: applicant.displayName,
      answers: payload.answers,
      paidMembershipAtApply: applicant.paidMembershipAtApply,
    },
    { availability: payload.availability, facilitatorPreferenceUids: [] },
  );

  const appRef = db.collection("courseApplications").doc(courseApplicationId(runId, user.uid));
  const runRef = db.collection("courseRuns").doc(runId);

  try {
    // One transaction so the doc and the run's counter can never disagree: the
    // decide route (P5) decrements `pending` in exactly this shape, and a
    // counter that drifts is a review queue that lies. `tx.create` is the
    // one-application-per-(run, uid) invariant — the read above only exists to
    // turn the resulting ALREADY_EXISTS into copy a human can act on.
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(appRef);
      if (existing.exists) {
        const status = (existing.data() ?? {}).status as CourseApplicationStatus;
        throw new ApplyError(
          status === "withdrawn"
            ? "You withdrew your application for this run. Get in touch with the team if you'd like it reinstated."
            : "You've already applied to this run — open the course page to view or edit your application.",
          409,
        );
      }
      tx.create(appRef, {
        ...doc,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(runRef, {
        "applicationCounts.pending": FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Lost the race between the read and the commit.
    if ((err as { code?: number }).code === 6) {
      return NextResponse.json(
        { error: "You've already applied to this run." },
        { status: 409 },
      );
    }
    console.error("[courses apply] transaction failed", runId, err);
    return NextResponse.json({ error: "Couldn't submit your application." }, { status: 500 });
  }

  // Post-commit and non-fatal: the application is saved either way, and a
  // confirmation email is a courtesy, not part of the write. Fire-and-forget
  // (the RSVP-submit pattern) — the applicant must not wait on SMTP.
  if (user.email) {
    void sendCourseApplicationEmail({
      kind: "submitted",
      to: user.email,
      name: applicant.displayName,
      courseTitle: run.courseTitle,
      runLabel: run.label,
      startDate: formatRunStart(run.startDate),
      uid: user.uid,
      runId,
    }).catch((err) => {
      console.error("[courses apply] submitted email failed", runId, user.uid, err);
    });
  }

  return NextResponse.json({ ok: true, id: appRef.id });
}

// ---------------------------------------------------------------------------
// PATCH — edit while pending
// ---------------------------------------------------------------------------

export async function PATCH(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const appRef = db.collection("courseApplications").doc(courseApplicationId(runId, user.uid));
  const snap = await appRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No application found." }, { status: 404 });
  }
  const existing = snap.data() ?? {};

  // Ownership is structural — the doc id is built from the session uid, so a
  // caller can only ever address their own row. Asserted anyway: if that ever
  // stops being true, this should fail closed rather than quietly edit someone
  // else's application.
  if (existing.uid !== user.uid) {
    return NextResponse.json({ error: "No application found." }, { status: 404 });
  }

  const status = existing.status as CourseApplicationStatus;
  if (status !== "pending") {
    return NextResponse.json(
      {
        error:
          status === "withdrawn"
            ? "You've withdrawn this application, so it can't be edited."
            : "This application has already been reviewed, so it can't be edited.",
      },
      { status: 403 },
    );
  }

  // Write-spam cooldown: reject edits landing within EDIT_COOLDOWN_SECONDS of
  // the last write, read off the doc's existing `updatedAt`.
  const last = existing.updatedAt as Timestamp | undefined;
  if (last && typeof last.toMillis === "function") {
    const elapsedMs = Timestamp.now().toMillis() - last.toMillis();
    if (elapsedMs < EDIT_COOLDOWN_SECONDS * 1000) {
      const wait = Math.ceil((EDIT_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000);
      return NextResponse.json(
        { error: `You're saving changes too quickly. Please wait ${wait}s and try again.` },
        { status: 429 },
      );
    }
  }

  const run = await loadRun(db, runId);
  if (!run) {
    return NextResponse.json({ error: "Course run not found." }, { status: 404 });
  }

  // GATED on the application window, and deliberately NOT on the maintenance
  // pause. The two are different promises: the pause exists to stop writes
  // while something is being fixed, and stranding a queued applicant mid-edit
  // for that helps nobody; the DEADLINE is a commitment to the applicant and to
  // the team reading them (owner decision D5). The submitted email says "any
  // time before the deadline", the status card drops its Edit button when the
  // window shuts, and this is the enforcement under both.
  const editError = editWindowError(run, new Date());
  if (editError) {
    return NextResponse.json({ error: editError }, { status: 403 });
  }

  const payload = await validatePayload(db, run, body);
  if ("error" in payload) {
    return NextResponse.json({ error: payload.error }, { status: 400 });
  }

  // Only the applicant-editable fields. Status, the paid-membership snapshot,
  // the email, and every reviewer/decision field stay server-owned and cannot
  // be reached from here. `availability` is written even when empty (unlike the
  // create path, which omits it) so clearing every chip actually clears it.
  await appRef.update({
    answers: payload.answers,
    availability: payload.availability,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, id: appRef.id });
}

// ---------------------------------------------------------------------------
// DELETE — withdraw
// ---------------------------------------------------------------------------

export async function DELETE(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;

  // Note: no `rejected` check. Turning away an account from WITHDRAWING its own
  // application would trap it in the queue with no self-service exit.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  const appRef = db.collection("courseApplications").doc(courseApplicationId(runId, user.uid));
  const runRef = db.collection("courseRuns").doc(runId);

  try {
    // A withdrawal is a SOFT delete: the row survives with `status:"withdrawn"`
    // so the audit trail (and the counters that summarise it) stay honest.
    // Transactional for the same reason POST is — the status and the two
    // counter deltas are one fact.
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);
      if (!snap.exists) throw new ApplyError("No application found.", 404);
      const existing = snap.data() ?? {};
      if (existing.uid !== user.uid) throw new ApplyError("No application found.", 404);

      const status = existing.status as CourseApplicationStatus;
      // Idempotent: a double-clicked Withdraw shouldn't surface a failure.
      if (status === "withdrawn") return { alreadyWithdrawn: true };
      if (status !== "pending") {
        throw new ApplyError(
          "This application has already been reviewed — decisions are handled by the team, so please get in touch instead.",
          409,
        );
      }

      tx.update(appRef, {
        status: "withdrawn" satisfies CourseApplicationStatus,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(runRef, {
        "applicationCounts.pending": FieldValue.increment(-1),
        "applicationCounts.withdrawn": FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { alreadyWithdrawn: false };
    });

    return NextResponse.json({ ok: true, status: "withdrawn", ...result });
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses apply] withdraw failed", runId, user.uid, err);
    return NextResponse.json({ error: "Couldn't withdraw your application." }, { status: 500 });
  }
}
