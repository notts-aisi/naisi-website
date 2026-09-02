import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import CourseNudgeEmail from "@/emails/CourseNudgeEmail";
import { addDaysToKey, isValidDateKey } from "@/lib/courses/weekPlan";
import type { GroupSession, GroupSessionMode } from "@/lib/firestore/courseGroups";
import {
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import { firstWord } from "@/lib/firestore/applicationEmails";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * THE WEEKLY COHORT NUDGE — template resolution, token building, rendering, the
 * send-dedupe marker id, and the one-recipient send. The route at
 * `/api/courses/runs/[runId]/nudge` decides WHO gets it and WHEN; this module
 * owns WHAT lands in the inbox and WHAT COUNTS AS "already sent".
 *
 * THIS IS THE ONLY IMPLEMENTATION. The route resolves the template through
 * `resolveCourseNudgeTemplate`, renders through `renderCourseNudge`, and sends
 * through `sendCourseWeekNudgeEmail`; it builds no tokens, escapes no HTML and
 * writes no unsubscribe markup of its own. The admin designer's preview and its
 * test send route through `renderCourseNudge` too, so an admin proofing the copy
 * sees the same degradation rules a recipient gets. Adding a second renderer
 * anywhere is how "Your group meets {sessionWhen}, {sessionWhere}." reaches a
 * cohort.
 *
 * ── WHY THIS IS A PREPARED SEND, NOT A SCHEDULED ONE ────────────────────────
 * App Hosting gives us no scheduler (see `weekPlan.ts`: nothing is ever
 * "advanced", the current week is a pure function of `(run, now)`), so a nudge
 * CANNOT FIRE ITSELF. The shipped shape is therefore a prepared, human-
 * triggered send: a facilitator or admin opens the run, sees this week's nudge
 * pre-filled from the template below, and sends it with one click.
 *
 * The important part is what that shape leaves room for. The send route is
 * IDEMPOTENT PER (run, CALENDAR SLOT): the position in the run is recomputed
 * server-side from `currentWeekFor(run, now)` — never taken from the caller —
 * and the send is claimed against a deterministic marker doc in `courseNudges`
 * (`nudgeMarkerId`, below) before any mail moves, with a marker anywhere in the
 * ±6-day span around that slot counting as the same week (`nudgeWeekMarkerIds`,
 * whose header says why the slot id alone is not enough). So the same endpoint can later
 * be handed to Cloud Scheduler or a GitHub Action on a daily cron and it will
 * send EXACTLY ONCE PER COHORT WEEK with no code change: six no-op calls and one
 * real send per week, whichever day the cron happens to run, and a human press
 * on the same day is absorbed by the same marker. Nothing here builds that
 * scheduler — it just refuses to make it a rewrite. Anything added to this
 * module must stay safe to call twice.
 *
 * ── ADMIN-EDITABLE COPY, FALLBACK-FIRST ────────────────────────────────────
 * The body is `courseEmailTemplates/course-week-nudge`, edited in Admin → Email
 * designs → Course emails, exactly like the five lifecycle templates. Nothing
 * seeds that doc: `resolveCourseNudgeTemplate` falls back to
 * `courseTemplateDefaults` when it is missing, malformed, or empty, so a fresh
 * deploy sends sensible copy before anyone opens the editor, and a Firestore
 * read failure degrades to the defaults rather than to silence.
 *
 * ── THE ANNOUNCEMENT LANE: THIS MAIL IS OPT-OUTABLE ────────────────────────
 * A nudge is not "your room moved" — it is a weekly announcement, so it carries
 * the same unsubscribe affordance as the cohort broadcast: a visible footer link
 * (`CourseNudgeEmail`) plus the RFC 8058 `List-Unsubscribe` headers, both
 * pointing at one signed token scoped to `cohort:<runId>`. The route owns the
 * rest of that lane (subscription ∩ active enrolment, the `courses` category
 * opt-out, suppression); see `/api/courses/runs/[runId]/email/route.ts`, whose
 * audience rules this send reuses verbatim.
 *
 * ── TOKEN VALUES ARE FACILITATOR-AUTHORED. THEY GO IN AS TEXT. ─────────────
 * The week title, the summary and the group's room name are typed by
 * facilitators in the week/group editors — they are DATA, not markup. Every
 * value is HTML-escaped before it is substituted into a `richText` block, and
 * collapsed to a single line first (so a multi-line summary cannot inject a
 * header break into a subject either). `personaliseBlocks` in
 * newsletterBlocks.ts deliberately does NOT escape — it serves admin-authored
 * lifecycle mail where the token values are names and titles from a controlled
 * path — which is exactly why the nudge renders through its own pass below
 * rather than reusing it. Adding a token means adding it to `CourseNudgeTokens`
 * and nowhere else; the escaping is applied by the renderer, not per token.
 *
 * ── GRACEFUL DEGRADATION IS A HARD REQUIREMENT, NOT POLISH ─────────────────
 * A member must never receive "Your group meets ." or a literal `{sessionWhen}`
 * or the word "undefined". The other course templates take the opposite line —
 * an unresolved token stays literal so an ADMIN notices — and that convention is
 * right for a decision email an admin proofs and wrong here, because the nudge
 * goes to a whole cohort on data a facilitator may simply not have filled in
 * yet. So the renderer guarantees three things:
 *
 *  1. Every token in `CourseNudgeTokens` always has a string value. Absent is
 *     `""`, never `undefined`, so nothing can print "undefined".
 *  2. A text unit — a heading, or one `<p>` inside a rich-text block — that
 *     references at least one token and whose tokens ALL resolved to empty is
 *     DROPPED WHOLE. That is what removes the sentence rather than leaving its
 *     scaffolding behind. It is an exact rule, not a heuristic: units with no
 *     tokens are never dropped, and a unit that resolved anything is kept.
 *  3. What survives goes through a punctuation tidy (`tidyText`) that closes up
 *     the mixed case, where one token in a sentence resolved and another did
 *     not: "18:00, ." becomes "18:00.", an emptied `<strong></strong>` is
 *     removed so the punctuation either side can meet, and an anchor whose href
 *     resolved to nothing is unwrapped to plain text rather than shipped dead.
 *
 * COPY RULE THAT FALLS OUT OF (2), and the seed template obeys it: KEEP EACH
 * OPTIONAL TOKEN IN ITS OWN PARAGRAPH, in plain text rather than inside a bold
 * or link tag. Two optional tokens may share a paragraph only when they are
 * comma-joined, and `buildCourseNudgeTokens` enforces the one pairing that
 * matters — `sessionWhere` is blanked whenever `sessionWhen` is empty, because
 * "meets, Hallward B12" is the one dangling sentence the tidy pass cannot fix.
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * Plain, warm, brief, active, sentence case. No marketing tone, no exclamation
 * marks, no emoji. It says what is happening and what the reader might do. It
 * NEVER implies the reader is behind, because it has no idea whether they are —
 * and a busy student who opted into something they care about does not need to
 * be chased. Copy edits should keep that; the defaults below are the reference.
 */

// ---------------------------------------------------------------------------
// The send-dedupe marker
// ---------------------------------------------------------------------------

/**
 * The id of the document that says "this cohort has had its nudge for this
 * stretch of calendar". `.create()` at this deterministic id IS the
 * once-per-cohort-week guarantee — the same structural trick the task mirror
 * uses — and it is claimed BEFORE the first message goes out, never after.
 *
 * ── WHY IT IS KEYED ON THE SLOT, NOT ON THE DISPLAY WEEK NUMBER ────────────
 * `slotStartKey` is the civil date the cohort's current 7-day slot began:
 * `startDate + floor(daysElapsed / 7) * 7`. It is a pure function of the run's
 * START DATE and the clock, and — unlike `weekNumber` — it does not consult
 * `weekPlan` at all.
 *
 * That difference is a duplicate-blast vector, not a nicety. `weekPlan` is
 * editable by a track lead, who is also an authorised nudge sender. Key the
 * marker on the display week and this interleaving sends a cohort two nudges in
 * one week, with no force flag, no admin, no audit entry, and a panel showing a
 * clean unsent state:
 *
 *   Monday    the w03 nudge sends and claims `…__w03`.
 *   Wednesday a track lead inserts a reading week into the plan, so today's slot
 *             now renders as week 4.
 *   Thursday  the next POST (or the next daily cron tick this is built for)
 *             looks for `…__w04`, finds nothing, and mails everyone again.
 *
 * Anchoring on the calendar closes it: renumbering a plan cannot move a slot
 * that has already started, so the marker claimed on Monday is still the marker
 * consulted on Thursday.
 *
 * ── WHY ONE ID IS NOT ENOUGH: `startDate` MOVES THE SLOT ITSELF ────────────
 * A track lead may edit a run's `startDate` (firestore.rules does not pin it)
 * and is also an authorised nudge sender, and moving it mints a DIFFERENT key
 * for the same calendar week:
 *
 *   Wed 14 Oct  the run started 28 Sep, so the slot is 12 Oct: the nudge sends
 *               and claims `…__2026-10-12`.
 *   Wed 14 Oct  the lead corrects `startDate` to 29 Sep. Same Wednesday, still
 *               week 3, but the slot is now 13 Oct.
 *   Thu 15 Oct  the next press — or the next cron tick — looks for
 *               `…__2026-10-13`, finds nothing, and mails the whole cohort
 *               again. Unlike a `force`, that writes a FRESH marker at
 *               `forceCount: 0`, so nothing on the record says it happened
 *               twice and the panel shows a clean unsent state.
 *
 * So "already sent for this week" is not one id but a SPAN.
 * `nudgeWeekMarkerIds` below lists this slot's id plus the twelve within ±6
 * days, and the route treats a marker at ANY of them as this calendar week's
 * nudge. Seven days out is genuinely the next week and is deliberately outside
 * the span.
 *
 * THE COST, TAKEN DELIBERATELY: moving `startDate` BACKWARDS by 1-6 days puts
 * the FOLLOWING week's slot inside the previous marker's span, so that one
 * week's nudge is suppressed until an admin forces it. That is the same trade
 * the send ordering makes — a missed nudge is a nudge, a duplicate blast is an
 * incident — and it is visible rather than silent, because the preview reports
 * the matched marker's claim time.
 *
 * `.create()` at the deterministic id REMAINS the guarantee: two ticks racing
 * inside one slot still aim at one document. The span check is a read in front
 * of it and cannot be atomic — which is the right shape, because what it
 * defends against is a human editing a run, not a race.
 *
 * Markers live in `courseNudges`, which firestore.rules already locks
 * `read, write: if false` as server-side course-email bookkeeping — so this
 * ships with NO rules change (a rules edit landing ahead of or behind its code
 * has broken prod here before). The collection is shared with the P9 send
 * throttle, which prefixes its docs `emailrate__`; ours are `nudge__`.
 *
 * CONSTRUCT-ONLY — never parsed. `runId`, `slotStartKey`, `weekNumber` and
 * `weekId` are all stored as fields on the document.
 */
export function nudgeMarkerId(runId: string, slotStartKey: string): string {
  return `nudge__${runId}__${slotStartKey}`;
}

/** How far either side of a slot a marker still means "this calendar week". */
const NUDGE_WEEK_SPAN_DAYS = 6;

/**
 * Every deterministic id that would mean "this cohort has already had its nudge
 * for this calendar week": THIS SLOT'S OWN ID FIRST, then the twelve within ±6
 * days of it. The header above carries the argument for why the span exists.
 *
 * Thirteen ids, read in one batch by the route. Order matters only in that the
 * first entry is the id a send actually claims; the rest are the neighbours a
 * `startDate` edit could have left behind.
 */
export function nudgeWeekMarkerIds(runId: string, slotStartKey: string): string[] {
  const ids = [nudgeMarkerId(runId, slotStartKey)];
  for (let offset = 1; offset <= NUDGE_WEEK_SPAN_DAYS; offset += 1) {
    ids.push(
      nudgeMarkerId(runId, addDaysToKey(slotStartKey, -offset)),
      nudgeMarkerId(runId, addDaysToKey(slotStartKey, offset)),
    );
  }
  return ids;
}

/**
 * The civil date this week's session falls on: the first day at or after the
 * slot's start whose weekday matches the group's.
 *
 * Feeds `courseNudgeSessionWhen`, which reads as a date ("Tuesday 26 August")
 * rather than a recurring label once it has one. Returns "" on input the week
 * maths would reject, which degrades to the recurring label rather than throwing
 * mid-send.
 */
export function courseNudgeSessionDateKey(
  slotStartKey: string,
  weekday: number,
): string {
  if (!isValidDateKey(slotStartKey)) return "";
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return "";
  // Parsed at midnight UTC, exactly as `weekPlan` parses every date key, so the
  // weekday read here is the civil one the slot boundary was computed from.
  const slotWeekday = new Date(`${slotStartKey}T00:00:00Z`).getUTCDay();
  return addDaysToKey(slotStartKey, (weekday - slotWeekday + 7) % 7);
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

export const COURSE_NUDGE_TEMPLATE_ID: CourseTemplateId = "course-week-nudge";

export type CourseNudgeTemplate = {
  subject: string;
  blocks: Block[];
  /** From the stored doc only; no editor sets it today. */
  fromName?: string;
  /** True when no usable stored doc existed and the seed copy is in play. */
  usingDefaults: boolean;
};

/**
 * Read the admin template once per REQUEST, never per recipient — a 200-person
 * cohort would otherwise cost 200 identical reads of the same doc.
 *
 * A stored template only wins when it is well-formed AND non-empty, matching
 * `sendCourseApplicationEmail`: an admin who saves a blank body gets the seed
 * copy rather than an empty email. A read failure degrades the same way, and
 * is logged rather than thrown — a nudge that sends on default copy is a far
 * better outcome than a cohort that gets nothing.
 */
export async function resolveCourseNudgeTemplate(
  db: Firestore,
): Promise<CourseNudgeTemplate> {
  const defaults = courseTemplateDefaults[COURSE_NUDGE_TEMPLATE_ID];
  try {
    const snap = await db
      .collection("courseEmailTemplates")
      .doc(COURSE_NUDGE_TEMPLATE_ID)
      .get();
    if (snap.exists) {
      const stored = normalizeCourseTemplate(snap.id, snap.data() ?? {});
      if (stored && stored.subject && stored.blocks.length > 0) {
        return {
          subject: stored.subject,
          blocks: stored.blocks,
          fromName: stored.fromName,
          usingDefaults: false,
        };
      }
    }
  } catch (err) {
    console.warn("[courseNudgeEmail] template read failed, using defaults", err);
  }
  return {
    subject: defaults.subject,
    blocks: defaults.blocks,
    usingDefaults: true,
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The nudge's token map. EVERY VALUE IS A STRING — "absent" is `""`, which the
 * renderer's unit-drop rule turns into a removed sentence. Keep this in sync
 * with the token help in `CourseEmailDesignEditor.tsx` and the sample values in
 * `courseEmailSamples.ts`; those two are what an admin proofs against.
 */
export type CourseNudgeTokens = {
  /** e.g. "AI Safety Fundamentals". */
  courseTitle: string;
  /** Which run, e.g. "Autumn 2026". */
  runLabel: string;
  /** The taught week number, as text. Always resolves — see the input type. */
  weekNumber: string;
  /** The week's title, e.g. "Goal misgeneralisation". */
  weekTitle: string;
  /** The week's one-line summary, collapsed to a single line. */
  weekSummary: string;
  /** Human session label, e.g. "Tuesday 26 August, 18:00–19:30". */
  sessionWhen: string;
  /** Where that session is, e.g. "Hallward B12" or "Online". */
  sessionWhere: string;
  /** Absolute link to the week page. */
  weekUrl: string;
  /**
   * The weekly feedback form, from `config/courses.weeklyFeedbackUrl`.
   *
   * Empty is the ordinary state until an admin sets one, and the paragraph
   * carrying it is then dropped whole rather than shipping a dead link. That
   * is why the send lane can resolve this from config with no branch of its
   * own: an unconfigured form degrades to a shorter email.
   */
  feedbackUrl: string;
  /** First word of the recipient's name, for the greeting. */
  firstName: string;
  /**
   * One derived sentence about what is worth doing before the session, e.g.
   * "There are four things to read or watch and one exercise to write up this
   * week, about 2 hours in total." Not in the original nine because it cannot
   * be assembled from them: it counts the week's non-optional materials and
   * required exercises, which only the server can see. Built by
   * `courseWeekPrepLine`.
   */
  weekPrep: string;
};

export type CourseNudgeTokenInput = {
  courseTitle?: string | null;
  runLabel?: string | null;
  /** Recomputed server-side from the run's plan. Never a client-supplied week. */
  weekNumber: number;
  weekTitle?: string | null;
  weekSummary?: string | null;
  sessionWhen?: string | null;
  sessionWhere?: string | null;
  weekUrl?: string | null;
  feedbackUrl?: string | null;
  /**
   * The recipient's display name. Pass an empty string when there isn't one —
   * NEVER a placeholder like "NAISI member", which would greet them "Hi NAISI,".
   * Empty drops the greeting line entirely, which is the graceful outcome.
   */
  recipientName?: string | null;
  weekPrep?: string | null;
};

/** Collapse to one line and trim. Also what keeps a summary out of a header. */
function oneLine(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function buildCourseNudgeTokens(
  input: CourseNudgeTokenInput,
): CourseNudgeTokens {
  const sessionWhen = oneLine(input.sessionWhen);
  return {
    courseTitle: oneLine(input.courseTitle),
    runLabel: oneLine(input.runLabel),
    weekNumber:
      Number.isFinite(input.weekNumber) && input.weekNumber >= 1
        ? String(Math.floor(input.weekNumber))
        : "",
    weekTitle: oneLine(input.weekTitle),
    weekSummary: oneLine(input.weekSummary),
    sessionWhen,
    // Paired on purpose: a room with no time is not a fact worth a sentence,
    // and "Your group meets, Hallward B12." is the one dangling shape the
    // punctuation tidy cannot repair. Blanking the pair drops the line instead.
    sessionWhere: sessionWhen ? oneLine(input.sessionWhere) : "",
    weekUrl: oneLine(input.weekUrl),
    feedbackUrl: oneLine(input.feedbackUrl),
    firstName: firstWord(oneLine(input.recipientName)),
    weekPrep: oneLine(input.weekPrep),
  };
}

/**
 * THE CONTRACT, as data. Four things have to agree about this list or an admin
 * proofs one email and a cohort receives another:
 *
 *   1. `CourseNudgeTokens` above — what the resolver produces.
 *   2. `courseTemplateDefaults["course-week-nudge"]` — the seed copy, which may
 *      only reference tokens on this list.
 *   3. `WEEK_TOKENS` in `CourseEmailDesignEditor.tsx` — what an admin is told
 *      they may type.
 *   4. `COURSE_NUDGE_PREVIEW_SAMPLE` + `courseSampleTokens` in
 *      `courseEmailSamples.ts` — what the designer's preview fills in.
 *
 * (3) and (4) live in client-reachable modules and cannot import this
 * `server-only` one, so the agreement is pinned by `tests/course-nudge.test.mjs`
 * rather than by the type system. Adding a token means touching all four.
 */
export const COURSE_NUDGE_TOKEN_KEYS = [
  "courseTitle",
  "runLabel",
  "weekNumber",
  "weekTitle",
  "weekSummary",
  "sessionWhen",
  "sessionWhere",
  "weekUrl",
  "feedbackUrl",
  "firstName",
  "weekPrep",
] as const satisfies readonly (keyof CourseNudgeTokens)[];

/**
 * Coerce a loose `{ key: string | undefined }` map into a full token map.
 *
 * For the admin surfaces ONLY — the designer preview and its test send, which
 * hold sample values rather than a run. A real send goes through
 * `buildCourseNudgeTokens`, which derives its values from documents. Unknown
 * keys are dropped and absent ones become "", so a preview exercises the same
 * "every value is a string" invariant the send guarantees, and the same
 * `sessionWhere`-follows-`sessionWhen` pairing.
 */
export function courseNudgeTokensFrom(
  raw: Record<string, string | undefined>,
): CourseNudgeTokens {
  const pick = (key: keyof CourseNudgeTokens) => oneLine(raw[key]);
  const sessionWhen = pick("sessionWhen");
  return {
    courseTitle: pick("courseTitle"),
    runLabel: pick("runLabel"),
    weekNumber: pick("weekNumber"),
    weekTitle: pick("weekTitle"),
    weekSummary: pick("weekSummary"),
    sessionWhen,
    sessionWhere: sessionWhen ? pick("sessionWhere") : "",
    weekUrl: pick("weekUrl"),
    feedbackUrl: pick("feedbackUrl"),
    firstName: pick("firstName"),
    weekPrep: pick("weekPrep"),
  };
}

// ---------------------------------------------------------------------------
// Deriving the harder token values
// ---------------------------------------------------------------------------

/** Index = `GroupSession.weekday` (`Date.getDay()`, 0 = Sunday). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function endTimeLabel(start: string, minutes: number): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return "";
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The `{sessionWhen}` value for ONE recipient's group.
 *
 * Pass `sessionDateKey` (the `YYYY-MM-DD` civil date this week's session falls
 * on, which the route already computes to place the session inside the slot)
 * and it reads as a date — "Tuesday 26 August, 18:00–19:30" — which is what a
 * weekly email wants. Without it, it falls back to the recurring house label
 * ("Tuesdays 18:00–19:30") that the apply page, the admissions queue and the
 * allocation board all render, so a member never meets two spellings of their
 * own slot.
 *
 * Returns "" — never a partial string — when the group has no time set, which
 * is what makes the whole session sentence disappear rather than dangle.
 */
export function courseNudgeSessionWhen(
  session: GroupSession | null | undefined,
  sessionDateKey?: string | null,
): string {
  if (!session || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  const time = `${session.startTimeLocal}${end ? `–${end}` : ""}`;

  if (sessionDateKey && /^\d{4}-\d{2}-\d{2}$/.test(sessionDateKey)) {
    const at = new Date(`${sessionDateKey}T12:00:00Z`);
    if (!Number.isNaN(at.getTime())) {
      // Noon UTC: far enough from either boundary that no London offset can
      // move the civil date this label names.
      const day = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(at);
      return `${day}, ${time}`;
    }
  }

  const day = WEEKDAY_NAMES[session.weekday];
  return day ? `${day}s ${time}` : time;
}

/**
 * The `{sessionWhere}` value.
 *
 * DELIBERATELY NOT THE MEETING URL. A group's video link is behind the authed
 * group page for a reason, and email is the most forwardable surface we have —
 * an online group gets the word "Online" here and the real link on the page
 * they are one click from. A group with neither a room nor a link returns "",
 * which (paired with `sessionWhen`) removes the sentence.
 *
 * ── `mode` OVERRIDES THE STORED FIELDS (v2 decision 7) ──────────────────────
 * The per-week virtual/in-person switch is the facilitator SAYING which
 * destination is live this week, and it wins over what the slot happens to
 * carry — which is the whole reason it exists. A group with a standing room
 * that meets online for one week has a non-empty `location`, and reading it
 * here mailed the cohort a room on the night nobody was in it. So:
 *
 *   · `"virtual"`   → "Online", whatever the room says. (Never the URL — see
 *                     above; the link is one click away on the week page.)
 *   · `"in-person"` → the room, and NEVER the "Online" fallback: a group with
 *                     a permanent meet link would otherwise be told "Online"
 *                     for a week their facilitator explicitly put in a room.
 *                     No room stored → "", which drops the sentence rather
 *                     than naming a destination that is wrong.
 *   · `null`        → the legacy resolution, unchanged.
 *
 * `courseNudgeSessionWhen` deliberately takes NO mode: a week that moves online
 * happens at the same hour on the same evening, so the mode cannot change the
 * `{sessionWhen}` string. Threading it through for symmetry would be a
 * parameter with no effect, which is the kind of thing a later reader "fixes".
 */
export function courseNudgeSessionWhere(
  session: GroupSession | null | undefined,
  mode?: GroupSessionMode | null,
): string {
  if (!session) return "";
  const location = session.location.trim();
  if (mode === "virtual") return "Online";
  if (mode === "in-person") return location;
  if (location) return location;
  return session.meetingUrl ? "Online" : "";
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "about 45 minutes" / "about 2 hours" / "about 1.5 hours"; "" when unknown. */
function durationLabel(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return "";
  }
  if (minutes < 75) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const hours = Math.round(minutes / 30) / 2;
  return `about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/**
 * The `{weekPrep}` sentence: what is actually in this week, counted off the
 * week doc. One SELF-CONTAINED sentence rather than a fragment, so the seed
 * template can drop it in as its own paragraph and lose the whole line cleanly
 * when a week has nothing authored yet.
 *
 * Optional materials are excluded (they are extension reading, and counting
 * them would inflate what the email implies is expected); so are non-required
 * exercises. Structural parameter type so a normalised `CourseWeekDoc` passes
 * straight in.
 */
export function courseWeekPrepLine(week: {
  materials?: readonly { optional?: boolean }[] | null;
  exercises?: readonly { required?: boolean }[] | null;
  estimatedMinutes?: number | null;
}): string {
  const materials = (week.materials ?? []).filter((m) => !m.optional).length;
  const exercises = (week.exercises ?? []).filter((x) => x.required).length;
  const duration = durationLabel(week.estimatedMinutes);

  const parts: string[] = [];
  if (materials > 0) {
    parts.push(
      `${countWord(materials)} ${materials === 1 ? "thing" : "things"} to read or watch`,
    );
  }
  if (exercises > 0) {
    parts.push(
      `${countWord(exercises)} ${exercises === 1 ? "exercise" : "exercises"} to write up`,
    );
  }

  if (parts.length === 0) {
    return duration ? `This week is ${duration} of reading.` : "";
  }
  const verb = materials + exercises === 1 ? "is" : "are";
  const tail = duration ? `, ${duration} in total` : "";
  return `There ${verb} ${parts.join(" and ")} this week${tail}.`;
}

/** The `{weekUrl}` value — the learning space's week page for this run. */
export function courseWeekUrl(
  appUrl: string,
  runId: string,
  weekNumber: number,
): string {
  const base = appUrl.replace(/\/+$/, "");
  if (!base || !runId || !Number.isFinite(weekNumber) || weekNumber < 1) return "";
  return `${base}/learn/${encodeURIComponent(runId)}/weeks/${Math.floor(weekNumber)}`;
}

// ---------------------------------------------------------------------------
// Rendering: substitute, drop, tidy
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Facilitator-authored text → HTML text. See the module header. */
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

type UnitResult = {
  text: string;
  /** True when the unit referenced tokens and every one of them was empty. */
  drop: boolean;
};

/**
 * Substitute one text unit and report whether it should survive.
 *
 * An UNKNOWN token (an admin typo, `{weekTtile}`) is left literal and does not
 * count as a reference — same house convention as everywhere else, and it means
 * a typo shows up in the designer's preview instead of silently deleting a
 * paragraph.
 */
function substituteUnit(
  input: string,
  tokens: CourseNudgeTokens,
  escape: boolean,
): UnitResult {
  let referenced = 0;
  let resolved = 0;
  const text = input.replace(TOKEN_PATTERN, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) return match;
    referenced += 1;
    const value = tokens[key as keyof CourseNudgeTokens];
    if (!value) return "";
    resolved += 1;
    return escape ? escapeHtml(value) : value;
  });
  return { text, drop: referenced > 0 && resolved === 0 };
}

/**
 * Sentinel for the entity mask below. U+0001 cannot appear in authored copy
 * (TipTap will not emit it, and it is not valid in an HTML attribute value), so
 * it cannot collide with anything a template legitimately contains.
 */
const MASK = "\u0001";
const MASK_PATTERN = /\u0001(\d+)\u0001/g;

/** `&quot;` `&#39;` `&#x2014;` — anything whose trailing `;` is structural. */
const HTML_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g;

/**
 * Punctuation hygiene for the MIXED case — one token in a sentence resolved,
 * another did not. Runs on text only, never on a tag, so no attribute value can
 * be mangled by it.
 *
 * ENTITIES ARE MASKED FIRST, and that is not a nicety: the escaped form of a
 * facilitator-typed quote is `&quot;`, whose `;` is a separator followed by
 * punctuation the moment the quote ends a sentence — so the stranded-separator
 * rule below would eat it and ship `&quot` to the inbox. Masking makes every
 * rule blind to the inside of an entity; nothing else here needs to know.
 */
function tidyText(input: string): string {
  const entities: string[] = [];
  const masked = input.replace(HTML_ENTITY, (m) => {
    entities.push(m);
    return `${MASK}${entities.length - 1}${MASK}`;
  });

  const tidied = masked
    .replace(/[ \t]*\r?\n[ \t]*/g, " ")
    // Emptied brackets go BEFORE the whitespace collapse, so the gap they leave
    // behind ("Fundamentals () is open") is closed by it rather than surviving.
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    // A separator left stranded in front of terminal punctuation: "18:00, ."
    .replace(/\s*[,;:·—–-]+\s*(?=[.,;:!?])/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    // Doubled separators, but never ".." — an admin's ellipsis survives.
    .replace(/([,;:])\1+/g, "$1");

  return entities.length === 0
    ? tidied
    : tidied.replace(MASK_PATTERN, (m, i: string) => entities[Number(i)] ?? m);
}

const INLINE_WRAPPERS = /<(strong|b|em|i|u|span|a)\b[^>]*>\s*<\/\1>/gi;
const EMPTY_HREF_ANCHOR = /<a\b[^>]*href\s*=\s*(?:""|'')[^>]*>([\s\S]*?)<\/a>/gi;

function tidyHtml(input: string): string {
  // A dead link is worse than plain text: unwrap an anchor whose href resolved
  // to nothing (an unset NEXT_PUBLIC_APP_URL, say) and keep its words.
  let out = input.replace(EMPTY_HREF_ANCHOR, "$1");
  // Then drop inline wrappers a vanished token left empty. This runs BEFORE the
  // text pass on purpose: removing `<strong></strong>` is what puts the ": " and
  // the "." into the same text node so the tidy can close them up.
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(INLINE_WRAPPERS, "");
    if (next === out) break;
    out = next;
  }
  return out.replace(/>([^<]+)</g, (_m, text: string) => `>${tidyText(text)}<`);
}

/** Any letter or digit left once the tags are gone? */
function hasVisibleText(html: string): boolean {
  return /[\p{L}\p{N}]/u.test(html.replace(/<[^>]*>/g, " "));
}

const PARAGRAPH_SPLIT = /(<p\b[^>]*>[\s\S]*?<\/p>)/i;

/**
 * Render one rich-text block. The drop rule applies PER PARAGRAPH, which is
 * what lets a single admin-authored block hold both the always-there lead and
 * the optional session line and lose only the second. Text outside any `<p>`
 * (a list, say) is treated as one further unit under the same rule — which is
 * why the copy rule in the header asks for one optional token per paragraph.
 *
 * Returns "" when nothing visible survived, and the caller drops the block.
 */
function renderRichText(html: string, tokens: CourseNudgeTokens): string {
  const segments = html.split(PARAGRAPH_SPLIT);
  const out = segments
    .map((segment) => {
      if (!segment) return "";
      const { text, drop } = substituteUnit(segment, tokens, true);
      if (drop) return "";
      const tidied = tidyHtml(text);
      // Belt-and-braces: a paragraph whose tokens technically "resolved" to
      // punctuation-only content still has no business in the email.
      if (/^<p\b/i.test(segment) && !hasVisibleText(tidied)) return "";
      return tidied;
    })
    .join("");
  return hasVisibleText(out) ? out : "";
}

export type RenderedCourseNudge = {
  /** Never empty — see `renderCourseNudge`. */
  subject: string;
  blocks: Block[];
  /** Inbox preview line, taken from the rendered body. */
  preheader: string;
};

/**
 * The reverse of `escapeHtml`, plus the entities an admin's editor emits on its
 * own (`&nbsp;` for a hard space, `&apos;` on some paste paths).
 */
const HTML_ENTITY_CHARS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Entities back to the characters they stand for, in ONE pass so nothing is
 * decoded twice: a facilitator who typed a literal "&amp;" arrives here as
 * "&amp;amp;" and must come out as "&amp;", not as "&". An entity this map does
 * not know is left exactly as it is rather than guessed at.
 */
function decodeEntities(input: string): string {
  return input.replace(HTML_ENTITY, (entity) => {
    const body = entity.slice(1, -1);
    if (!body.startsWith("#")) return HTML_ENTITY_CHARS[body.toLowerCase()] ?? entity;
    const code = /^#[xX]/.test(body)
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return entity;
    // A lone surrogate would make the preview line invalid UTF-16 for the sake
    // of an entity nothing in this module can emit.
    if (code >= 0xd800 && code <= 0xdfff) return entity;
    return String.fromCodePoint(code);
  });
}

/**
 * First ~140 characters of the rendered body — the inbox preview line.
 *
 * IT IS TEXT, NOT MARKUP, and that distinction is a real bug rather than a
 * pedantry. `block.html` is ALREADY-ESCAPED (see the module header), so a week
 * titled `What's next` reaches here as `What&#39;s next`; react-email's
 * `<Preview>` renders whatever it is handed as a plain React child and escapes
 * it a SECOND time, so the recipient's Gmail snippet literally reads
 * `What&#39;s next`. Stripping the tags is therefore only half the job — the
 * entities have to come back to characters too, and that includes the ones the
 * admin's editor produced for an ampersand simply typed into the template.
 *
 * Decoding is safe precisely BECAUSE the result is a React child: it goes back
 * out through the renderer's own escaping, never through
 * `dangerouslySetInnerHTML`. Tags are stripped first so `&lt;script&gt;` is
 * read as the text it is rather than reconstituted into a tag and then deleted.
 *
 * Heading text is NOT decoded: it never went through `escapeHtml` (a heading is
 * a React child in the body too), so an entity there is a literal an admin
 * typed, and the preview line should read exactly as the heading does.
 *
 * `<Preview>` renders inside `display:none`, so NO on-screen surface shows this
 * line — not the admin designer, not the facilitator panel. Only a real inbox
 * does, which is why it is asserted in `tests/course-nudge.test.mjs`.
 */
function preheaderOf(blocks: Block[]): string {
  for (const block of blocks) {
    const text =
      block.type === "heading"
        ? block.text
        : block.type === "richText"
          ? decodeEntities(block.html.replace(/<[^>]*>/g, " "))
          : "";
    const flat = text.replace(/\s+/g, " ").trim();
    // Skip the greeting: "Hi Alex," is a wasted preview line.
    if (!flat || /^h(i|ello)\b/i.test(flat)) continue;
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  }
  return "";
}

/**
 * Apply the tokens to a template and return something safe to send.
 *
 * The SUBJECT cannot be dropped the way a paragraph can, so it gets the same
 * substitution plus a trim of any separator left stranded at either end
 * ("Week 3 of AI Safety Fundamentals:" → "Week 3 of AI Safety Fundamentals").
 * If an admin manages to write a subject made entirely of tokens that all
 * resolve to nothing, a derived fallback takes over rather than an empty
 * `Subject:` header going out.
 *
 * Dividers are collapsed and trimmed at the edges, because a rule left leading
 * or trailing by a dropped block reads as a rendering fault.
 */
export function renderCourseNudge(
  template: { subject: string; blocks: Block[] },
  tokens: CourseNudgeTokens,
): RenderedCourseNudge {
  const subjectUnit = substituteUnit(template.subject, tokens, false);
  const subjectText = tidyText(subjectUnit.text)
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s,;:·—–-]+/, "")
    .replace(/[\s,;:·—–-]+$/, "")
    .trim();
  // The unit-drop rule decides here too — it just can't delete the subject, so
  // it swaps in a derived one instead. Without this, a subject made only of
  // tokens that all resolved to nothing survives as its own scaffolding
  // ("Week {weekNumber} of {courseTitle}" → "Week of"), which is worse than
  // either an honest fallback or an empty header.
  const subject =
    subjectUnit.drop || !subjectText ? fallbackSubject(tokens) : subjectText;

  const rendered: Block[] = [];
  for (const block of template.blocks) {
    switch (block.type) {
      case "heading": {
        // Rendered as a React child, so it escapes by construction — passing it
        // through `escapeHtml` here would print "&amp;" in the inbox.
        const { text, drop } = substituteUnit(block.text, tokens, false);
        const tidied = tidyText(text).trim();
        if (drop || !hasVisibleText(tidied)) break;
        rendered.push({ ...block, text: tidied });
        break;
      }
      case "richText": {
        const html = renderRichText(block.html, tokens);
        if (!html) break;
        rendered.push({ ...block, html });
        break;
      }
      case "image": {
        rendered.push({
          ...block,
          alt: substituteUnit(block.alt, tokens, false).text,
          caption: block.caption
            ? substituteUnit(block.caption, tokens, false).text
            : block.caption,
        });
        break;
      }
      case "video": {
        rendered.push({
          ...block,
          caption: block.caption
            ? substituteUnit(block.caption, tokens, false).text
            : block.caption,
        });
        break;
      }
      case "divider": {
        rendered.push(block);
        break;
      }
    }
  }

  return {
    subject,
    blocks: trimDividers(rendered),
    preheader: preheaderOf(rendered),
  };
}

function fallbackSubject(tokens: CourseNudgeTokens): string {
  const week = tokens.weekNumber ? `Week ${tokens.weekNumber}` : "This week";
  return tokens.courseTitle ? `${week} of ${tokens.courseTitle}` : `${week} on your course`;
}

function trimDividers(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.type === "divider") {
      if (out.length === 0) continue;
      if (out[out.length - 1].type === "divider") continue;
    }
    out.push(block);
  }
  while (out.length > 0 && out[out.length - 1].type === "divider") out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Test sends are marked in the SUBJECT LINE, not just the send log — the point
 * is that whoever pressed the button can tell at a glance, in their own inbox,
 * that what landed was a rehearsal. Same as the P9 staff routes.
 */
function envelopeSubject(subject: string, test: boolean): string {
  return test ? `[TEST] ${subject}` : subject;
}

/** Per-send facts. Resolved ONCE by the route, shared by every recipient. */
export type CourseNudgeRunContext = {
  courseTitle?: string | null;
  runLabel?: string | null;
  /** Recomputed server-side from `currentWeekFor(run, now)`. */
  weekNumber: number;
  weekTitle?: string | null;
  weekSummary?: string | null;
  /** From `courseWeekPrepLine(week)`. */
  weekPrep?: string | null;
  /** From `courseWeekUrl(appUrl, runId, weekNumber)`. */
  weekUrl?: string | null;
  /** From `config/courses.weeklyFeedbackUrl`. "" when none is configured. */
  feedbackUrl?: string | null;
};

export type SendCourseWeekNudgeArgs = {
  /** ONE address. The route dispatches per recipient — never a list, never a Cc. */
  to: string;
  runId: string;
  /** Whoever pressed send (or the service identity, once a cron does). */
  actorUid: string;
  /** True when this is a rehearsal to the sender's own address. */
  test: boolean;
  /** The recipient's display name, or "" — never a placeholder. */
  recipientName?: string | null;
  /** This recipient's group session, pre-formatted. "" when they have none. */
  sessionWhen?: string | null;
  sessionWhere?: string | null;
  /** `/api/unsubscribe?t=<signed>` for THIS recipient and THIS run's channel. */
  unsubscribeUrl: string;
  /** From `resolveCourseNudgeTemplate(db)` — resolve once, pass to every send. */
  template: CourseNudgeTemplate;
  context: CourseNudgeRunContext;
};

/**
 * Send one nudge to one member.
 *
 * No `replyTo` and no `fromName` of our own: `EMAIL_DEFAULT_REPLY_TO` and
 * `SMTP_FROM_NAME` apply, and the dev backend overrides the latter to
 * "NAISI (dev)" — the only thing distinguishing a dev send in a real inbox, on
 * the highest-volume mail in the estate. A `fromName` stored on the template
 * still wins, matching `sendCourseApplicationEmail`; nothing sets it today, and
 * an admin who ever does has said so deliberately.
 *
 * Throwing is the caller's to catch: the route counts a failed recipient as
 * skipped and carries on, exactly as the cohort broadcast does.
 */
export async function sendCourseWeekNudgeEmail(
  args: SendCourseWeekNudgeArgs,
): Promise<void> {
  const tokens = buildCourseNudgeTokens({
    courseTitle: args.context.courseTitle,
    runLabel: args.context.runLabel,
    weekNumber: args.context.weekNumber,
    weekTitle: args.context.weekTitle,
    weekSummary: args.context.weekSummary,
    weekPrep: args.context.weekPrep,
    weekUrl: args.context.weekUrl,
    feedbackUrl: args.context.feedbackUrl,
    sessionWhen: args.sessionWhen,
    sessionWhere: args.sessionWhere,
    recipientName: args.recipientName,
  });

  const { subject, blocks, preheader } = renderCourseNudge(args.template, tokens);

  await sendEmail({
    to: args.to,
    subject: envelopeSubject(subject, args.test),
    react: CourseNudgeEmail({
      subject,
      blocks,
      unsubscribeUrl: args.unsubscribeUrl,
      preheader: preheader || subject,
    }),
    fromName: args.template.fromName,
    // `course-test` for a rehearsal so the deliverability tab can tell every
    // course test send from a real one, exactly as P9 does it.
    kind: args.test ? "course-test" : "course-nudge",
    actorUid: args.actorUid,
    referenceId: args.runId,
    // Both halves of the opt-out: the footer link the recipient can see, and
    // the RFC 8058 headers Gmail/Yahoo want on bulk mail. One signed token,
    // scoped to this run's cohort channel and nothing else.
    listUnsubscribe: {
      url: args.unsubscribeUrl,
      mailto: process.env.EMAIL_DEFAULT_REPLY_TO,
    },
  });
}
