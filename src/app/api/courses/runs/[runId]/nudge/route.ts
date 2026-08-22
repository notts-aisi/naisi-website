import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import {
  courseNudgeSessionDateKey,
  courseNudgeSessionWhen,
  courseNudgeSessionWhere,
  courseWeekPrepLine,
  courseWeekUrl,
  nudgeMarkerId,
  nudgeWeekMarkerIds,
  renderCourseNudge,
  resolveCourseNudgeTemplate,
  sendCourseWeekNudgeEmail,
  buildCourseNudgeTokens,
} from "@/lib/email/courseNudgeEmail";
import {
  dispatchSends,
  dropSuppressed,
  gateRunStaff,
  memberNameOf,
  ownAddressFor,
  reserveSendSlot,
  resolveCohortAudience,
  type CohortRecipient,
} from "@/lib/email/courseFacilitatorEmails";
import { currentWeekFor, isValidDateKey } from "@/lib/courses/weekPlan";
import { courseEnrolmentId, normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup, sessionForWeek } from "@/lib/firestore/courseGroups";
import {
  COURSE_RUN_STATUS_LABEL,
  courseRunChannel,
  normalizeCourseWeek,
  weekDocId,
  type CourseRunDoc,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import { signToken } from "@/lib/signedTokens";

/**
 * THE WEEK NUDGE — "a new week of the course is live, here's what's in it".
 *
 * ── A PREPARED SEND, NOT A SCHEDULED ONE (the shape of this whole route) ────
 * App Hosting is Cloud Run with a 60s request ceiling and NO SCHEDULER, so a
 * nudge cannot fire itself. Everything else in the courses feature is paced
 * lazily off page mounts (see the task mirror in `sync-tasks`), but mail is not
 * a thing you may send on a stranger's page mount: whoever's browser happens to
 * load the run home first would be the one who mailed 200 people.
 *
 * So the nudge is HUMAN-TRIGGERED: a facilitator or admin opens the composer,
 * reads the GET preview (what it will say, who it will reach), and sends this
 * week's nudge with one click from the pre-filled template.
 *
 * ── …BUILT TO BE CRONNED LATER WITHOUT A CODE CHANGE ────────────────────────
 * The endpoint is IDEMPOTENT PER (run, calendar week). Point a daily Cloud
 * Scheduler job or a GitHub Action at `POST /api/courses/runs/{runId}/nudge` and
 * it sends exactly ONCE per cohort week: the first tick after the week rolls
 * sends, and every tick after that returns `{ ok: true, alreadySent: true,
 * sent: 0 }` having done THREE ADDRESSED READS AND NO QUERY — the run (the auth
 * gate), the week (is there anything to nudge about), and one batched `getAll`
 * of the thirteen marker ids that could hold this week's claim. That property is
 * deliberate and load-bearing — design changes here must preserve it. Three
 * things make it work:
 *
 *   1. The cohort's position is RECOMPUTED server-side from `(run, now)` — the
 *      route reads no week number from anybody, so a cron with no idea what week
 *      it is asks the right question by asking nothing.
 *   2. The marker claim is a `.create()` at a DETERMINISTIC id keyed on the
 *      CALENDAR SLOT (`nudgeMarkerId`, whose header carries the full argument),
 *      so two ticks racing each other cannot both send — and neither can a track
 *      lead renumbering the week plan mid-week. An edit to the run's `startDate`
 *      moves the slot itself and would mint a fresh id for the same calendar
 *      week; `nudgeWeekMarkerIds` closes that by treating any marker within ±6
 *      days as this week's.
 *   3. The body is OPTIONAL. A cron POSTing with no body at all is a valid
 *      "send this week's nudge" — `{}` is the default.
 *
 * What is deliberately NOT built: the scheduler itself, and any machine
 * identity for it. The auth gate below is unchanged and a future cron will have
 * to present a real session (or whatever `getCurrentUser()` grows to accept).
 * Wiring one up is a config job plus an identity decision, not a rewrite.
 *
 * ── IDEMPOTENCY: CLAIM FIRST, THEN SEND ─────────────────────────────────────
 * Before dispatching, the route `.create()`s the marker. Deterministic id +
 * `.create()` IS the guarantee — the same structural trick the task mirror uses
 * — and it is claimed BEFORE the first message goes out, never after.
 *
 * THAT ORDERING TRADES "POSSIBLE PARTIAL SEND" FOR "NEVER A DUPLICATE BLAST",
 * which is the right trade for email. If the container dies half way through a
 * 200-person cohort, the marker already exists: the next cron tick sends
 * nothing, and some of the cohort missed that week's nudge. The alternative —
 * stamp after a successful loop — would mean a crash at recipient 190 re-mails
 * the first 189 on the next tick, forever, until someone notices. A missed
 * nudge is a nudge; a duplicate blast is an incident. `force` (below) is the
 * escape hatch for the rare case where the partial send needs finishing, and it
 * is auditable rather than silent.
 *
 * `force: true` is ADMIN-ONLY and does not erase the marker: it records who
 * forced, when, and how many times it has been forced, so a second send to a
 * cohort is always visible on the record afterwards. A force over a NEIGHBOURING
 * marker — the `startDate`-edit case, where the claim this send collides with
 * lives under a different id — cannot be recorded by the `.create()` failing,
 * so the neighbour it overrode is written INTO the new marker instead
 * (`forcedOverMarkerId`, and `forceCount` starting at 1). A cohort mailed twice
 * in one calendar week is on the record either way.
 *
 * ── WHO MAY SEND, AND WHO RECEIVES ──────────────────────────────────────────
 * `gateRunStaff` and `resolveCohortAudience` in
 * `src/lib/email/courseFacilitatorEmails.ts`, the SAME two functions the P9
 * cohort announcement route calls. That sharing is the point: a nudge is an
 * announcement to the whole run, so facilitating one GROUP of it is not enough
 * (a group facilitator mails their own room through the group route), and the
 * audience is the cohort subscription channel INTERSECTED with an ACTIVE
 * enrolment, opt-out honoured, suppression filtered, capped with a refusal
 * rather than a truncation. Both derivations used to be written out twice, once
 * per route, under a comment saying "IF YOU CHANGE ONE, CHANGE BOTH"; they are
 * now written once.
 *
 * ── WHAT IT SAYS ────────────────────────────────────────────────────────────
 * `src/lib/email/courseNudgeEmail.ts` owns every word of it: template
 * resolution, the token map, the escaping, the drop-the-sentence degradation
 * rule, and the render through `CourseNudgeEmail` (which carries the visible
 * unsubscribe line to pair with the RFC 8058 headers). THIS ROUTE BUILDS NO
 * COPY. It resolves the facts a nudge is about — which week, which session,
 * which link — and hands them over. Anything token-shaped added here instead of
 * there is a second implementation, and the first thing a second implementation
 * does is stop resolving a token the template uses.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * GET — what the nudge WOULD say and who it WOULD reach, so a sender can read
 * it before committing.
 *
 * `week: null` means there is nothing to nudge about (the run has not started,
 * has finished, sits on a break, or this week is unauthored/unpublished). It is
 * a SUCCESS, not a failure, and the human reason travels in `bodyPreview` with
 * `subjectPreview` empty — the surface shows the reason where the copy would
 * be, and `week === null` is the machine-readable half.
 *
 * `recipients` is a COUNT and never addresses. It is the post-opt-out,
 * post-suppression number — i.e. what `sent` should come back as — except when
 * the cohort is over the recipient cap, where it is the enrolled count so the
 * surface can say "260 recipients, over the 200 limit" before POST refuses.
 *
 * `alreadySentAt` is the claim time of the marker holding this calendar week
 * (ISO), or null when this week's nudge has not gone out — and always null when
 * `week` is null, since the marker is per (run, slot) and there is no slot to
 * nudge about. It reads the same ±6-day span POST refuses on
 * (`findWeekMarker`), so a `startDate` edit cannot make a week the cohort has
 * already been mailed show here as unsent.
 *
 * `sessionLine` is what the session sentence resolves to IN THIS PREVIEW — the
 * reader's own group's slot for this week if they hold a placement on the run,
 * else the line every active group shares, else null. Real recipients each get
 * their OWN group's line by the same rule (`groupContextFor`).
 */
export type NudgePreviewPayload = {
  week: {
    weekNumber: number;
    weekId: string;
    title: string;
    summary: string;
  } | null;
  recipients: number;
  alreadySentAt: string | null;
  sessionLine: string | null;
  subjectPreview: string;
  bodyPreview: string;
};

/**
 * POST — the send result.
 *
 * `alreadySent` means "a marker for this (run, CALENDAR WEEK) existed BEFORE
 * this request" — this slot's own marker, or one within ±6 days of it left
 * behind by a `startDate` edit (see `findWeekMarker`). On the ordinary path
 * that implies `sent: 0` and nothing was mailed.
 * On an admin `force` it is TRUE ALONGSIDE a non-zero `sent` — the honest
 * reading, because the cohort has now had the nudge twice. A cron's "nothing
 * happened" test is therefore `alreadySent === true && sent === 0`, and any
 * surface reporting this to a human must test `sent` before it tests
 * `alreadySent` (see `NudgePanel`).
 *
 * A test send never touches the marker, so it always reports
 * `alreadySent: false` — a rehearsal says nothing about the real send's state.
 * `GET`'s `alreadySentAt` is the field to read for that.
 */
export type NudgeSendResult = {
  ok: true;
  weekNumber: number | null;
  sent: number;
  skipped: number;
  alreadySent: boolean;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A run has a handful of groups; the same bound the overview route uses. */
const MAX_GROUPS = 50;

/** Matches the rules' `weekNumber` bounds and `maxWeekPlanEntries`. */
const MAX_WEEK_NUMBER = 60;

const WINDOW_MS = 60 * 60 * 1000;
/**
 * Real sends per (sender, run) per hour. The marker is what actually prevents a
 * duplicate week; this bounds forced re-sends and a misconfigured cron hammering
 * the endpoint, and reuses the same durable counter the P9 routes use.
 */
const SENDS_PER_WINDOW = 3;
/** Test sends per (sender, run) per hour, on their own counter. */
const TEST_SENDS_PER_WINDOW = 10;

/** Same lifetime the newsletter gives its unsubscribe links. */
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * Run statuses that may nudge, as an ALLOWLIST so a status added later fails
 * closed. Same set the task mirror uses, and for the same reason: a cohort whose
 * calendar has started but whose status still says `applications-closed` is a
 * live cohort with a live week, and refusing over a bookkeeping lag would block
 * a real nudge. `draft` has no cohort; `completed` and `cancelled` must never
 * mail anyone again, whatever the calendar says.
 */
const NUDGING_STATUSES = new Set<CourseRunStatus>([
  "applications-open",
  "applications-closed",
  "running",
]);

/**
 * This lane's voice in the shared audience derivation — the console tag an
 * operator greps for, and the advice that completes the over-cap refusal.
 */
const LANE = {
  logTag: "courses nudge",
  overCapAdvice: "split the cohort",
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * ALREADY_EXISTS out of `.create()`. The Admin SDK surfaces the raw gRPC status
 * (6); the string forms are accepted because the emulator and some transport
 * paths report the canonical name instead. Anything else is a real failure.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

function markerSentAtIso(data: Record<string, unknown> | undefined): string | null {
  const at = data?.sentAt;
  if (at instanceof Timestamp) return at.toDate().toISOString();
  if (at instanceof Date) return at.toISOString();
  return null;
}

/** An existing claim on this cohort's calendar week. */
type WeekMarkerHit = {
  snap: DocumentSnapshot;
  /**
   * True when the claim sits under a DIFFERENT slot id — i.e. the run's
   * `startDate` moved after the cohort was mailed, so `.create()` at today's id
   * would succeed and re-mail them. See `nudgeWeekMarkerIds`.
   */
  isNeighbour: boolean;
};

/**
 * The marker already claiming this cohort's calendar week, if there is one.
 *
 * ONE BATCHED `getAll` of the thirteen deterministic ids — this slot's and the
 * twelve within ±6 days — so the span costs one round trip rather than
 * thirteen. Addressed reads, no query, no index.
 *
 * THIS SLOT'S OWN MARKER WINS when both exist: it is the one the claim's
 * `.create()` will collide with, and the one already carrying the force record.
 * Results are matched by id rather than by position, so nothing here depends on
 * `getAll` preserving the order it was asked in.
 */
async function findWeekMarker(
  db: Firestore,
  runId: string,
  slotStartKey: string,
): Promise<WeekMarkerHit | null> {
  const ids = nudgeWeekMarkerIds(runId, slotStartKey);
  const snaps = await db.getAll(
    ...ids.map((id) => db.collection("courseNudges").doc(id)),
  );
  const exact = snaps.find((snap) => snap.exists && snap.id === ids[0]);
  if (exact) return { snap: exact, isNeighbour: false };
  const neighbour = snaps.find((snap) => snap.exists);
  return neighbour ? { snap: neighbour, isNeighbour: true } : null;
}

// ---------------------------------------------------------------------------
// Week resolution — the server ALWAYS recomputes
// ---------------------------------------------------------------------------

type ResolvedWeek =
  | {
      ok: true;
      weekNumber: number;
      weekId: string;
      /** The civil date this cohort's current 7-day slot began. Keys the marker. */
      slotStartKey: string;
      title: string;
      summary: string;
      /** `{weekPrep}` — one sentence counting what is in the week. */
      prep: string;
    }
  | { ok: false; reason: string };

/**
 * Which week this run is on RIGHT NOW, and whether it is nudgeable.
 *
 * `currentWeek.weekNumber` — not `anchorWeekNumber` — is the one used: the
 * anchor deliberately holds a cohort mid-break at the week behind it (right for
 * "you should be up to here" surfaces), but a break is precisely when NOT to
 * mail "a new week is live". Break, before, after and a not-yet-published week
 * all resolve to "nothing to send", each with a human reason.
 */
async function resolveNudgeWeek(
  db: Firestore,
  run: CourseRunDoc,
  now: Date,
): Promise<ResolvedWeek> {
  if (!NUDGING_STATUSES.has(run.status)) {
    return {
      ok: false,
      reason: `This run is ${COURSE_RUN_STATUS_LABEL[run.status].toLowerCase()}, so there's no weekly nudge to send.`,
    };
  }
  // `currentWeekFor` throws `RangeError` on a malformed start date by design,
  // and a half-authored run (created, no start date chosen) is a legitimate
  // state — so the guard is required rather than defensive noise.
  if (!isValidDateKey(run.startDate)) {
    return {
      ok: false,
      reason: "This run has no start date yet, so there's no week to nudge about.",
    };
  }

  const currentWeek = currentWeekFor(
    { startDate: run.startDate, weekPlan: run.weekPlan },
    now,
  );
  if (currentWeek.phase === "before") {
    return {
      ok: false,
      reason: `The cohort hasn't started yet — week 1 begins on ${run.startDate}.`,
    };
  }
  if (currentWeek.phase === "after") {
    return {
      ok: false,
      reason: "This run has finished — there's no current week to nudge about.",
    };
  }
  if (currentWeek.weekNumber === null) {
    const label = currentWeek.breakLabel || "a break";
    return {
      ok: false,
      reason: `The cohort is on ${label} this week — nothing to send.`,
    };
  }

  const weekNumber = currentWeek.weekNumber;
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > MAX_WEEK_NUMBER) {
    // A corrupt plan entry, which must not be allowed to build a doc id.
    return { ok: false, reason: "This run's week plan is malformed — nothing to send." };
  }

  // Addressed as `weekDocId(n)`, which is what the member-facing week page
  // resolves and what the task mirror embeds. The plan entry's own `weekId` is
  // NOT used: it can drift from the display number across a copy-forward, and a
  // nudge pointing at a different doc than the page shows is a wrong nudge.
  const weekId = weekDocId(weekNumber);
  const snap = await db
    .collection("courseRuns")
    .doc(run.id)
    .collection("weeks")
    .doc(weekId)
    .get();
  if (!snap.exists) {
    return {
      ok: false,
      reason: `Week ${weekNumber} hasn't been authored yet, so there's nothing to point people at.`,
    };
  }
  const week = normalizeCourseWeek(snap.id, snap.data() ?? {});
  // An unpublished week is invisible to learners. Nudging them towards a page
  // they cannot open is worse than not nudging — and because the marker is only
  // claimed on a real send, the nudge fires on the first request AFTER
  // publication rather than being lost.
  if (!week.published) {
    return {
      ok: false,
      reason: `Week ${weekNumber} isn't published yet — publish it before nudging the cohort.`,
    };
  }

  return {
    ok: true,
    weekNumber,
    weekId,
    slotStartKey: currentWeek.slotStartKey,
    title: week.title,
    summary: week.summary,
    prep: courseWeekPrepLine(week),
  };
}

// ---------------------------------------------------------------------------
// Group session resolution — one pair of token values per recipient
// ---------------------------------------------------------------------------

/** What `{sessionWhen}` and `{sessionWhere}` resolve to for one recipient. */
type SessionContext = { sessionWhen: string; sessionWhere: string };

/**
 * Separator for the "do all the groups share one session?" key below. A
 * character that cannot occur in a time or a room name, so two different
 * (when, where) pairs can never spell the same key — the house idiom, matching
 * `SEP` in `src/features/courses/useReviewQueue.ts`.
 *
 * WRITTEN AS AN ESCAPE ON PURPOSE: a literal NUL byte in the source makes
 * GNU/BSD `grep -r` report "Binary file … matches" and print nothing, which
 * silently hid this route from a reviewer's own sweep for nudge renderers.
 */
const SESSION_KEY_SEP = "\u0000";

const NO_SESSION: SessionContext = { sessionWhen: "", sessionWhere: "" };

type GroupIndex = {
  byGroupId: Map<string, SessionContext>;
  /** The pair every active group shares; null when it varies or none is set. */
  common: SessionContext | null;
};

/**
 * The run's active groups, indexed for per-recipient token resolution, plus the
 * ONE session every group shares (null when it varies, or when there are no
 * groups yet).
 *
 * The session is resolved through `sessionForWeek`, so a one-week room or time
 * change is reflected, and dated through the slot the cohort is actually in —
 * which is what lets `{sessionWhen}` read "Tuesday 26 August, 18:00–19:30"
 * rather than the recurring "Tuesdays 18:00–19:30" a weekly email has no use for.
 */
async function loadGroups(
  db: Firestore,
  runId: string,
  weekId: string,
  slotStartKey: string,
): Promise<GroupIndex> {
  const snap = await db
    .collection("courseGroups")
    .where("runId", "==", runId)
    .limit(MAX_GROUPS)
    .get();
  const groups = snap.docs
    .map((d) => normalizeCourseGroup(d.id, d.data() ?? {}))
    .filter((g) => !g.archived);

  const byGroupId = new Map<string, SessionContext>();
  const distinct = new Set<string>();
  for (const group of groups) {
    const session = sessionForWeek(group, weekId);
    const sessionWhen = courseNudgeSessionWhen(
      session,
      courseNudgeSessionDateKey(slotStartKey, session.weekday),
    );
    if (!sessionWhen) continue;
    const context: SessionContext = {
      sessionWhen,
      sessionWhere: courseNudgeSessionWhere(session),
    };
    byGroupId.set(group.id, context);
    distinct.add(`${context.sessionWhen}${SESSION_KEY_SEP}${context.sessionWhere}`);
  }
  const common =
    distinct.size === 1 && byGroupId.size === groups.length
      ? ([...byGroupId.values()][0] ?? null)
      : null;
  return { byGroupId, common };
}

/**
 * ONE RULE, used by the preview, the rehearsal and every real recipient: a
 * member with a placement gets THEIR group's session; anyone without one — an
 * accepted-but-unallocated member, or a sender rehearsing on a run they don't
 * sit in — falls back to the session every group shares. Neither available
 * resolves both tokens to "", and the renderer then deletes the sentence rather
 * than shipping "Your group meets ." — see `courseNudgeEmail.ts`.
 *
 * THE SHARED-SESSION FALLBACK IS FOR THE UNPLACED ONLY. A member who HAS a
 * `groupId` that is absent from the index — their group was archived after
 * they were placed, or deleted, or has no time set — must get NO session
 * sentence rather than another group's. `loadGroups` filters archived groups
 * out, so before this guard an archived-group member was mailed a time and
 * room they must not turn up to, which is worse than the silence the drop rule
 * gives them. Placement is the question; "some group meets then" is not an
 * answer to it.
 */
function groupContextFor(groups: GroupIndex, groupId: string | null): SessionContext {
  if (groupId) return groups.byGroupId.get(groupId) ?? NO_SESSION;
  return groups.common ?? NO_SESSION;
}

/** The caller's own placement on this run, if they have one. */
async function ownGroupId(db: Firestore, runId: string, uid: string): Promise<string | null> {
  const snap = await db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, uid))
    .get();
  if (!snap.exists) return null;
  return normalizeCourseEnrolment(snap.id, snap.data() ?? {}).groupId;
}

/**
 * The one display string the panel shows under "The session it points at". Not
 * a token — the email names the two facts in its own sentence — but the two
 * halves read as one line on a summary surface.
 */
function sessionLineOf(context: SessionContext): string | null {
  if (!context.sessionWhen) return null;
  return context.sessionWhere
    ? `${context.sessionWhen} · ${context.sessionWhere}`
    : context.sessionWhen;
}

/** Blocks → the plain-text preview the composer shows. Never sent anywhere. */
function blocksToPreviewText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        parts.push(block.text);
        break;
      case "richText":
        parts.push(
          block.html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .trim(),
        );
        break;
      case "image":
        if (block.caption || block.alt) parts.push(`[image: ${block.caption || block.alt}]`);
        break;
      case "video":
        if (block.caption) parts.push(`[video: ${block.caption}]`);
        break;
      case "divider":
        break;
    }
  }
  return parts
    .map((p) => p.replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// GET — the preview
// ---------------------------------------------------------------------------

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const gate = await gateRunStaff(runId);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  const { actor, db, run } = gate;

  const resolved = await resolveNudgeWeek(db, run, new Date());
  if (!resolved.ok) {
    // A success with nothing to send. The reason travels in `bodyPreview` — see
    // NudgePreviewPayload. `alreadySentAt` is null because the marker is per
    // (run, slot) and there is no slot to nudge about.
    const payload: NudgePreviewPayload = {
      week: null,
      recipients: 0,
      alreadySentAt: null,
      sessionLine: null,
      subjectPreview: "",
      bodyPreview: resolved.reason,
    };
    return NextResponse.json(payload);
  }

  const [marker, audience, groups, template, actorSnap, senderGroupId] = await Promise.all([
    findWeekMarker(db, runId, resolved.slotStartKey),
    resolveCohortAudience(db, runId, LANE),
    loadGroups(db, runId, resolved.weekId, resolved.slotStartKey),
    resolveCourseNudgeTemplate(db),
    db.collection("users").doc(actor.uid).get(),
    ownGroupId(db, runId, actor.uid),
  ]);

  // The preview renders with the SENDER's own name and their own group context,
  // so it matches byte for byte what their test send will put in their inbox.
  // NO PLACEHOLDER: `firstWord("NAISI member")` is "NAISI", and a preview headed
  // "Hi NAISI," teaches the wrong thing about what a nameless member receives.
  const senderName = actorSnap.exists
    ? memberNameOf(actorSnap.data() ?? {})
    : (actor.displayName?.trim() ?? "");
  const sessionContext = groupContextFor(groups, senderGroupId);

  const rendered = renderCourseNudge(
    template,
    buildCourseNudgeTokens({
      courseTitle: run.courseTitle,
      runLabel: run.label,
      weekNumber: resolved.weekNumber,
      weekTitle: resolved.title,
      weekSummary: resolved.summary,
      weekPrep: resolved.prep,
      weekUrl: courseWeekUrl(
        process.env.NEXT_PUBLIC_APP_URL ?? "",
        runId,
        resolved.weekNumber,
      ),
      sessionWhen: sessionContext.sessionWhen,
      sessionWhere: sessionContext.sessionWhere,
      recipientName: senderName,
    }),
  );

  const payload: NudgePreviewPayload = {
    week: {
      weekNumber: resolved.weekNumber,
      weekId: resolved.weekId,
      title: resolved.title,
      summary: resolved.summary,
    },
    // Over the cap, the ENROLLED count is the useful number ("260, over the 200
    // limit"); POST is the boundary that refuses. GET is a preview, not a gate.
    recipients: audience.refusal ? audience.enrolledCount : audience.members.length,
    // The same span POST refuses on, so the panel and the send agree about
    // whether this calendar week has been mailed.
    alreadySentAt: marker ? markerSentAtIso(marker.snap.data()) : null,
    sessionLine: sessionLineOf(sessionContext),
    subjectPreview: rendered.subject,
    // The message, not the chrome: no logo, no unsubscribe footer. These are the
    // blocks the send would render, dropped sentences and all, flattened back to
    // text — not a second, differently-substituted rendering of the copy.
    bodyPreview: blocksToPreviewText(rendered.blocks),
  };
  return NextResponse.json(payload);
}

// ---------------------------------------------------------------------------
// POST — the send
// ---------------------------------------------------------------------------

type ParsedBody = { testOnly: boolean; force: boolean };

/**
 * `{ testOnly?, force? }` — and an ABSENT body is valid. A cron POSTing nothing
 * at all must mean "send this week's nudge"; see the module comment.
 */
function parseBody(raw: unknown): { ok: true; value: ParsedBody } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: { testOnly: false, force: false } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object body." };
  }
  const b = raw as Record<string, unknown>;
  if (b.testOnly !== undefined && typeof b.testOnly !== "boolean") {
    return { ok: false, error: "testOnly must be true or false." };
  }
  if (b.force !== undefined && typeof b.force !== "boolean") {
    return { ok: false, error: "force must be true or false." };
  }
  return { ok: true, value: { testOnly: b.testOnly === true, force: b.force === true } };
}

export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const gate = await gateRunStaff(runId);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  const { actor, db, run, isAdmin } = gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    // No body, or an unparseable one. A cron sends nothing; treat that as `{}`.
    raw = undefined;
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { testOnly, force } = parsed.value;

  // Checked BEFORE the marker is consulted, so the permission does not depend on
  // state: `force` is an admin-only flag whether or not it would have done
  // anything. Distinguishable only to a caller who has ALREADY passed the
  // run-staff gate, so it discloses nothing — and mailing a cohort a second time
  // is worth refusing out loud rather than silently ignoring the flag.
  if (force && !isAdmin) {
    return NextResponse.json(
      { error: "Only an admin can force a nudge to re-send." },
      { status: 403 },
    );
  }

  const now = new Date();
  const resolved = await resolveNudgeWeek(db, run, now);
  if (!resolved.ok) {
    // Nothing to send is a SUCCESS — this is the answer a cron gets on every
    // tick during a reading week. Logged so a scheduler's output explains itself.
    console.log("[courses nudge] nothing to send", runId, resolved.reason);
    const result: NudgeSendResult = {
      ok: true,
      weekNumber: null,
      sent: 0,
      skipped: 0,
      alreadySent: false,
    };
    return NextResponse.json(result);
  }

  const markerRef = db
    .collection("courseNudges")
    .doc(nudgeMarkerId(runId, resolved.slotStartKey));

  // ── THE CRON HOT PATH ────────────────────────────────────────────────────
  // One batched read of the thirteen ids that could hold this calendar week's
  // claim, no audience derivation, no rate-limit slot consumed. This is an
  // optimisation for the same-slot case, NOT the guarantee — the `.create()`
  // below is what actually makes a duplicate impossible, exactly as the task
  // mirror's high-water mark sits in front of its deterministic `.create()`.
  //
  // For the NEIGHBOUR case it is more than an optimisation: a marker under a
  // different slot id cannot collide with the create, so this read is the only
  // thing standing between a `startDate` edit and a second blast. Held for the
  // claim below, which records the neighbour when an admin forces past it.
  let claimed: WeekMarkerHit | null = null;
  if (!testOnly) {
    claimed = await findWeekMarker(db, runId, resolved.slotStartKey);
    if (claimed && !force) {
      const result: NudgeSendResult = {
        ok: true,
        weekNumber: resolved.weekNumber,
        sent: 0,
        skipped: 0,
        alreadySent: true,
      };
      return NextResponse.json(result);
    }
  }

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const channel = courseRunChannel(runId);

  const actorSnap = await db.collection("users").doc(actor.uid).get();
  const actorData = actorSnap.data() ?? {};
  // Placeholder-free on purpose — see the GET preview.
  const senderName = actorSnap.exists
    ? memberNameOf(actorData)
    : (actor.displayName?.trim() ?? "");

  const [groups, template] = await Promise.all([
    loadGroups(db, runId, resolved.weekId, resolved.slotStartKey),
    resolveCourseNudgeTemplate(db),
  ]);

  let skipped = 0;
  let recipients: CohortRecipient[] = [];

  if (testOnly) {
    const own = ownAddressFor(actorData, actor.email, gmailOnly);
    if (!own) {
      return NextResponse.json(
        { error: "Your account has no email address on file to send a test to." },
        { status: 400 },
      );
    }
    // The rehearsal resolves the sender's OWN placement if they have one, so a
    // facilitator sees what their group will see (and the GET preview, which
    // resolves it the same way, matches the rehearsal byte for byte).
    //
    // SUPPRESSION APPLIES TO A REHEARSAL TOO, exactly as it does on the
    // announcement route: a sender whose own address has bounced has to learn
    // that from the test rather than from a cohort send that reports success.
    const { deliverable, dropped } = await dropSuppressed(db, [
      {
        uid: actor.uid,
        address: own,
        recipientName: senderName,
        ownName: senderName,
        groupId: await ownGroupId(db, runId, actor.uid),
      },
    ]);
    recipients = deliverable;
    skipped += dropped;
  } else {
    const audience = await resolveCohortAudience(db, runId, LANE);
    if (audience.refusal) {
      return NextResponse.json({ error: audience.refusal }, { status: 400 });
    }
    recipients = audience.members;
    skipped += audience.skipped;
  }

  if (recipients.length === 0) {
    // Deliberately does NOT claim the marker: an audience that is empty today
    // (everyone opted out, nobody allocated yet) must not permanently suppress
    // this week's nudge for whoever becomes deliverable tomorrow.
    const result: NudgeSendResult = {
      ok: true,
      weekNumber: resolved.weekNumber,
      sent: 0,
      skipped,
      alreadySent: false,
    };
    return NextResponse.json(result);
  }

  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `nudge${testOnly ? "test" : ""}__${runId}__${actor.uid}`,
      limit: testOnly ? TEST_SENDS_PER_WINDOW : SENDS_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    // Fail CLOSED — a throttle on outbound mail has only one safe direction.
    console.error("[courses nudge] throttle read failed", runId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      {
        error: testOnly
          ? "Too many test sends for this run in the last hour."
          : `You can send ${SENDS_PER_WINDOW} nudges an hour to this cohort. Try again shortly.`,
      },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  // ── CLAIM THE MARKER BEFORE DISPATCHING ──────────────────────────────────
  // See the module comment for why this ordering trades a possible partial send
  // for never a duplicate blast. A test send claims nothing — it reached only
  // its own sender, and the cohort's week is still owed its nudge.
  let alreadySent = false;
  if (!testOnly) {
    const stamp = Timestamp.fromDate(now);
    // The `startDate`-edit case: the claim on this calendar week sits under a
    // NEIGHBOURING id, so the `.create()` below succeeds and the collision that
    // normally records a force never happens. Only an admin reaches here with a
    // neighbour in hand (a non-forced request returned in the hot path), and the
    // fact has to be written INTO the new marker or the second blast leaves no
    // trace at all.
    const forcedOverMarkerId = claimed?.isNeighbour ? claimed.snap.id : null;
    try {
      await markerRef.create({
        kind: "week-nudge",
        runId,
        // The slot is the KEY (see `nudgeMarkerId`); the week number and week id
        // are stored so the document reads as something a human can interpret.
        slotStartKey: resolved.slotStartKey,
        weekNumber: resolved.weekNumber,
        weekId: resolved.weekId,
        // The CLAIM time and the count this send was claimed FOR. Not a
        // confirmed delivery count — per-recipient truth lives in `emailSends`.
        sentAt: stamp,
        sentByUid: actor.uid,
        recipientCount: recipients.length,
        // A marker born of a force over a neighbour starts at 1: the cohort has
        // had this calendar week's nudge twice, and this document is the only
        // place that can say so.
        forceCount: forcedOverMarkerId ? 1 : 0,
        forces: forcedOverMarkerId
          ? [
              {
                uid: actor.uid,
                at: stamp,
                recipientCount: recipients.length,
                forcedOverMarkerId,
              },
            ]
          : [],
        // Firestore refuses `undefined`, so the neighbour fields are present
        // only when there was one.
        ...(forcedOverMarkerId
          ? { forcedOverMarkerId, lastForcedAt: stamp, lastForcedByUid: actor.uid }
          : {}),
      });
      if (forcedOverMarkerId) {
        // The cohort HAS had this week's nudge before, under the other id.
        alreadySent = true;
        console.warn(
          "[courses nudge] FORCED re-send over a neighbouring marker",
          runId,
          resolved.weekNumber,
          actor.uid,
          forcedOverMarkerId,
          recipients.length,
        );
      }
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Lost the race, or an admin forcing over an existing marker.
      alreadySent = true;
      if (!force) {
        const result: NudgeSendResult = {
          ok: true,
          weekNumber: resolved.weekNumber,
          sent: 0,
          skipped,
          alreadySent: true,
        };
        return NextResponse.json(result);
      }
      // AUDIT FIRST, then send: a forced re-send must be on the record before a
      // single message leaves, so a crash mid-force still leaves evidence. The
      // marker is UPDATED, never deleted — the record of the first send survives
      // the second. `forces` grows by one small map per force, bounded in
      // practice by the hourly send throttle above.
      await markerRef.update({
        forceCount: FieldValue.increment(1),
        lastForcedAt: stamp,
        lastForcedByUid: actor.uid,
        forces: FieldValue.arrayUnion({
          uid: actor.uid,
          at: stamp,
          recipientCount: recipients.length,
        }),
      });
      console.warn(
        "[courses nudge] FORCED re-send of an already-sent week",
        runId,
        resolved.weekNumber,
        actor.uid,
        recipients.length,
      );
    }
  }

  let sent = 0;
  // Bounded concurrency, not a sequential sleep — `dispatchSends` carries the
  // wall-clock arithmetic that keeps a full-size cohort send inside App
  // Hosting's 60s request timeout, with the rate-limit slot already spent.
  await dispatchSends(recipients, async (recipient) => {
    // One token per recipient, scoped to THIS run's channel: clicking it drops
    // the cohort and nothing else. The token addresses the UID, so unsubscribing
    // flips the rows for both of that member's addresses.
    const token = signToken(
      { s: "unsubscribe", uid: recipient.uid, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;
    const sessionContext = groupContextFor(groups, recipient.groupId);

    try {
      // ONE address. One message. Never an array, never a Cc — a cohort is up to
      // 200 people and one batched envelope would hand all 200 addresses to all
      // 200 people.
      await sendCourseWeekNudgeEmail({
        to: recipient.address,
        runId,
        actorUid: actor.uid,
        test: testOnly,
        // The placeholder-free name: "" drops the greeting rather than
        // addressing a member as "NAISI".
        recipientName: recipient.ownName,
        sessionWhen: sessionContext.sessionWhen,
        sessionWhere: sessionContext.sessionWhere,
        unsubscribeUrl,
        template,
        context: {
          courseTitle: run.courseTitle,
          runLabel: run.label,
          weekNumber: resolved.weekNumber,
          weekTitle: resolved.title,
          weekSummary: resolved.summary,
          weekPrep: resolved.prep,
          weekUrl: courseWeekUrl(appUrl, runId, resolved.weekNumber),
        },
      });
      sent += 1;
    } catch (err) {
      // Uid only — an address must not reach the logs.
      console.error("[courses nudge] send failed", runId, recipient.uid, err);
      skipped += 1;
    }
  });

  if (testOnly) {
    console.log("[courses nudge] TEST send to sender only", runId, resolved.weekNumber, actor.uid);
  } else {
    console.log(
      "[courses nudge] sent",
      runId,
      resolved.weekNumber,
      { sent, skipped, forced: alreadySent },
    );
  }

  const result: NudgeSendResult = {
    ok: true,
    weekNumber: resolved.weekNumber,
    sent,
    skipped,
    alreadySent,
  };
  return NextResponse.json(result);
}
