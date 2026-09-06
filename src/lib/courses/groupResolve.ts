import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import {
  currentWeekFor,
  isValidDateKey,
  type CurrentWeek,
  type WeekPlanEntry,
} from "./weekPlan";
import { normalizeCourseWeek, type CourseWeekDoc } from "../firestore/courses";
import { normalizeGroupWeek, type GroupWeekDoc } from "../firestore/courseGroups";

/**
 * GROUP-FIRST RESOLUTION — the one shared helper for per-group autonomy
 * (v2 decision 4, refined to COPY-ON-WRITE).
 *
 * A group tracks its run's canonical curriculum and calendar until its
 * facilitator personalises them. From that moment:
 *
 *  - a member's WEEK CONTENT = their group's forked week
 *    (`courseGroups/{groupId}/weeks/{wNN}`) if it exists, else the run
 *    canonical (`courseRuns/{runId}/weeks/{wNN}`);
 *  - a member's CALENDAR = their group's `paceStartDate`/`paceWeekPlan`
 *    overrides if set (`null` = track the run), else the run's.
 *
 * THE DESIGN RULE: every schedule/content consumer resolves through THIS
 * module. Nothing resolves group content ad hoc — a consumer that re-derives
 * "which week doc does this member see" or "when does this member's week
 * roll" by hand is a bug even when its answer happens to agree today.
 *
 * Public + pre-allocation surfaces stay run-canonical by construction: they
 * pass `group = null` (an unallocated member HAS no group), and the fall-
 * through below is the run.
 *
 * ## Isomorphic, like `weekPlan.ts`
 *
 * The calendar half is pure and shared by client components, server
 * components and route handlers. The `resolveWeek*` helpers need a
 * `Firestore` handle and are server-only in practice — the firebase-admin
 * import is TYPE-ONLY so this module never drags the Admin SDK into a client
 *  bundle.
 *
 * ## Malformed input
 *
 * `memberCurrentWeek` inherits `currentWeekFor`'s contract: it throws
 * `RangeError` on a start date that is not a real civil date. A group's
 * `paceStartDate` cannot be the thrower — `normalizeCourseGroup` nulls
 * anything `isValidDateKey` rejects, degrading to run-tracking — so the guard
 * consumers already hold (`isValidDateKey(run.startDate)`) remains the only
 * one needed.
 */

export type WeekSource = "run" | "group";

/** The two calendar fields, structurally — a run doc satisfies this. */
export type RunCalendarSource = {
  startDate: string;
  weekPlan: WeekPlanEntry[];
};

/** The group-side overrides, structurally — a group doc satisfies this. */
export type GroupPaceSource = {
  /** `null` = track the run's `startDate`. */
  paceStartDate: string | null;
  /** `null` = track the run's `weekPlan`. */
  paceWeekPlan: WeekPlanEntry[] | null;
};

export type ResolvedCalendar = {
  startDate: string;
  weekPlan: WeekPlanEntry[];
  /** "group" iff at least one group override is in effect. */
  source: WeekSource;
};

/**
 * The calendar a member is actually paced by. Per-FIELD fallback, per the
 * pinned contract: a group that re-dated its start but kept the run's plan
 * shape gets `{ group start, run plan }` — and `source` says "group" the
 * moment either override is set, because that is the fact the pacing banner
 * and the allocation board disclose.
 */
export function resolveCalendar(
  run: RunCalendarSource,
  group: GroupPaceSource | null,
): ResolvedCalendar {
  const paceStartDate = group?.paceStartDate ?? null;
  const paceWeekPlan = group?.paceWeekPlan ?? null;
  if (paceStartDate === null && paceWeekPlan === null) {
    return { startDate: run.startDate, weekPlan: run.weekPlan, source: "run" };
  }
  return {
    startDate: paceStartDate ?? run.startDate,
    weekPlan: paceWeekPlan ?? run.weekPlan,
    source: "group",
  };
}

/**
 * Where THIS MEMBER's cohort-week is right now: `currentWeekFor` over their
 * group's resolved calendar. The group-aware replacement for every
 * `currentWeekFor(run, now)` call on a member-facing surface — same civil-
 * date week-roll semantics, same DST-proofness, same `RangeError` contract
 * (see the module comment).
 */
export function memberCurrentWeek(
  run: RunCalendarSource,
  group: GroupPaceSource | null,
  now: Date = new Date(),
): CurrentWeek {
  const calendar = resolveCalendar(run, group);
  return currentWeekFor(calendar, now);
}

/**
 * ONE GROUP'S WHOLE CALENDAR, resolved: the dates it is paced by, how many
 * taught weeks that plan holds, and where it is right now.
 *
 * ── WHY THIS EXISTS AS A UNIT ───────────────────────────────────────────────
 * `resolveCalendar` and `memberCurrentWeek` were always meant to be read as a
 * pair, and every caller that read one and not the other has been a bug. The
 * run overview resolved ONE calendar for the caller and then drew a card per
 * group off it, so a facilitator holding a Monday group on the run's pacing and
 * a Thursday group three weeks behind was shown the same week number, the same
 * slot start and the same session override on both cards. Two groups, one
 * calendar, and no way to tell from the page which one was lying.
 *
 * So the unit of resolution is A GROUP, not a caller. Hand this function each
 * group in turn and every card is answered on its own clock.
 *
 * `currentWeek` is null on an unusable start date rather than throwing: a
 * half-authored run is a legitimate state (see the module header), and the
 * `RangeError` contract belongs to `currentWeekFor`, not to a summary a page
 * renders. A caller that must ALSO suppress the week for another reason (a
 * draft run, say) nulls it downstream; this function knows only about dates.
 */
export type GroupCalendar = {
  calendar: ResolvedCalendar;
  /** Taught weeks in the RESOLVED plan, breaks excluded. */
  totalWeeks: number;
  /** Null when the resolved start date is not a usable civil date. */
  currentWeek: CurrentWeek | null;
};

export function resolveGroupCalendar(
  run: RunCalendarSource,
  group: GroupPaceSource | null,
  now: Date = new Date(),
): GroupCalendar {
  const calendar = resolveCalendar(run, group);
  return {
    calendar,
    totalWeeks: calendar.weekPlan.filter((entry) => entry.kind === "week").length,
    currentWeek: isValidDateKey(calendar.startDate) ? currentWeekFor(calendar, now) : null,
  };
}

/** A group as this resolver needs it: its id, plus its pace overrides. */
export type IdentifiedGroup = GroupPaceSource & { id: string };

/**
 * The same answer for a LIST of groups, keyed by id: one resolution each, on
 * one clock.
 *
 * The shared clock is the point: resolving group A at 23:59:59 and group B a
 * millisecond later can land them in different cohort weeks across a midnight,
 * and a page that reported that would be reporting the request's timing rather
 * than the groups' pacing.
 */
export function resolveGroupCalendars(
  run: RunCalendarSource,
  groups: readonly IdentifiedGroup[],
  now: Date = new Date(),
): Map<string, GroupCalendar> {
  const out = new Map<string, GroupCalendar>();
  for (const group of groups) {
    if (out.has(group.id)) continue;
    out.set(group.id, resolveGroupCalendar(run, group, now));
  }
  return out;
}

/**
 * The cohort week a FRESH enrolment joins at, ON THE TARGET GROUP'S CLOCK.
 *
 * `anchorWeekNumber` is the last taught week that has started (0 before the
 * run, clamped to week 1 so a pre-term join, the normal case, anchors
 * everyone to the beginning). A run or group with no usable start date also
 * anchors to week 1 rather than throwing: `memberCurrentWeek` inherits
 * `currentWeekFor`'s `RangeError` contract, so the RESOLVED start date is
 * what has to be guarded, not the run's.
 *
 * ── WHY THE GROUP AND NOT THE RUN ───────────────────────────────────────────
 * `joinedWeekNumber` is a FLOOR, and the attendance route enforces it. Stamp
 * the run's week onto someone joining a group paced three weeks behind and
 * they join at run-week 5 while their group sits on week 3: weeks 3 and 4,
 * the weeks they are about to attend, come back "hadn't joined the group in
 * week 3", the grid renders those cells inert, and `ProgressBody` leaves them
 * out of the member's own total.
 *
 * `group === null` (unplaced) resolves the run canonical, which is exactly
 * what an ungrouped member is paced by.
 *
 * SHARED, not copied: both writers of a fresh enrolment call this one
 * function. The allocation route stamps it for an accepted applicant; the
 * open-enrol route stamps it for someone who picked their own session. Two
 * copies of this arithmetic is how the two writers end up disagreeing about
 * which week a person joined in.
 */
export function joinedWeekFor(
  run: RunCalendarSource,
  group: GroupPaceSource | null,
  now: Date = new Date(),
): number {
  const calendar = resolveCalendar(run, group);
  return isValidDateKey(calendar.startDate)
    ? Math.max(1, memberCurrentWeek(run, group, now).anchorWeekNumber)
    : 1;
}

// ---------------------------------------------------------------------------
// Divergence — the allocation board's disclosure predicate
// ---------------------------------------------------------------------------

/**
 * What `groupsDiverge` compares: a group's pace overrides plus the ids of the
 * weeks it has forked. The forked ids live in a SUBCOLLECTION, so the caller
 * (which has already listed them for its own display) hands them in — this
 * module does not hide a Firestore fan-out inside a predicate. The allocation
 * board builds this shape per column, and `null` stands for the run
 * canonical (the unallocated pool, or a group with no autonomy fields yet).
 */
export type GroupDivergenceInput = GroupPaceSource & {
  /** Doc ids ("w03") under `courseGroups/{id}/weeks`. Order irrelevant. */
  forkedWeekIds: readonly string[];
};

/**
 * `groupsDiverge`'s answer: TWO independent facts, not one boolean — a group
 * can share the run's calendar and still have rewritten half its weeks, and
 * vice versa, and the board's note has to say which. Callers must check both
 * lanes (`d.pace || d.content`), never the object's truthiness.
 */
export type GroupDivergence = {
  /** The two calendars differ (compared as OVERRIDES — see groupsDiverge). */
  pace: boolean;
  /** At least one side has forked content. */
  content: boolean;
};

/** The run canonical, spelt as a divergence input: no overrides, no forks. */
const RUN_CANONICAL: GroupDivergenceInput = {
  paceStartDate: null,
  paceWeekPlan: null,
  forkedWeekIds: [],
};

function weekPlanEntriesEqual(a: WeekPlanEntry, b: WeekPlanEntry): boolean {
  if (a.kind === "week") {
    return b.kind === "week" && a.weekNumber === b.weekNumber && a.weekId === b.weekId;
  }
  return b.kind === "break" && a.label === b.label;
}

function weekPlansEqual(
  a: WeekPlanEntry[] | null,
  b: WeekPlanEntry[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((entry, i) => weekPlanEntriesEqual(entry, b[i]));
}

/**
 * Whether moving a member between these two groups crosses a content or
 * pacing boundary, by lane — the allocation board shows its divergence note
 * when EITHER lane flags (v2 red-team consequence: "allocation board
 * discloses divergence"). `null` on either side = the run canonical: the
 * unallocated pool, which is precisely what an unplaced member reads.
 *
 * DELIBERATELY CONSERVATIVE, and the asymmetries are the point:
 *
 *  - `content`: ANY forked week on EITHER side flags — including when both
 *    groups forked the SAME week ids. Two forks of w03 are two independent
 *    copies with independent edits; equal id sets prove nothing, and this
 *    predicate does not read week bodies to find out. A fork is a
 *    declaration of divergence from canonical, and a move across one
 *    deserves the note even in the rare case the fork is still
 *    byte-identical.
 *  - `pace`: overrides compare as OVERRIDES, not as resolved calendars: a
 *    group whose `paceStartDate` happens to equal the run's start diverges
 *    from a group tracking the run. Resolving would need the run doc and
 *    would hide the operational fact that one group has left the run's
 *    clock.
 *
 * False positives cost one advisory sentence on the board; a false negative
 * moves a member silently across a curriculum boundary. Both lanes err
 * accordingly.
 */
export function groupsDiverge(
  a: GroupDivergenceInput | null,
  b: GroupDivergenceInput | null,
): GroupDivergence {
  const from = a ?? RUN_CANONICAL;
  const to = b ?? RUN_CANONICAL;
  return {
    content: from.forkedWeekIds.length > 0 || to.forkedWeekIds.length > 0,
    pace:
      (from.paceStartDate ?? null) !== (to.paceStartDate ?? null) ||
      !weekPlansEqual(from.paceWeekPlan, to.paceWeekPlan),
  };
}

/** "a", "a and b" — the note's two lanes never exceed two items. */
function listOf(parts: string[]): string {
  return parts.join(" and ");
}

/**
 * What the allocation board's note calls the two ends of a move.
 *
 * `target: null` is THE UNALLOCATED POOL, and it is a distinct case rather
 * than a name: the pool is not a group, it has no weeks and no schedule of its
 * own — it IS the run canonical — so it may never appear as the subject of
 * "runs on its own schedule" or "'s weeks".
 */
export type DivergenceLabels = {
  /** The column being left. */
  source: string;
  /** The column being moved to, or `null` for the unallocated pool. */
  target: string | null;
  /** The mover(s), as the board names them: "Ada", "those 3 people". */
  who: string;
};

/**
 * THE BOARD'S DISCLOSURE SENTENCE for one (origin → destination) move, or
 * `null` when the two ends agree and there is nothing to disclose.
 *
 * ── WHY THIS IS NOT JUST `groupsDiverge` + A TEMPLATE ───────────────────────
 * `groupsDiverge` is SYMMETRIC by design: it answers "does this move cross a
 * boundary", not "which side is the unusual one". The board's first note
 * attributed every crossing to the TARGET unconditionally — so moving someone
 * OUT of a forked, re-paced group and back into the unallocated pool read
 * "Unallocated runs on its own schedule and has its own version of some weeks,
 * unlike Group B", which is three falsehoods in one sentence about a column
 * that is definitionally the run canonical.
 *
 * So divergence is computed PER SIDE — each end against the run canonical —
 * and the copy is chosen by direction:
 *
 *  · the TARGET diverges  → what they are moving INTO is unusual;
 *  · only the SOURCE does → what they are LEAVING was, and the destination is
 *    the course's own;
 *  · both                 → both clauses, in that order.
 *
 * THE SYMMETRIC PREDICATE IS STILL THE GATE. A lane is only ever WORDED when
 * `groupsDiverge(from, to)` flags it, so two groups holding the identical pace
 * override still produce no pacing sentence: nothing about the mover's
 * schedule changes, whatever either group does relative to the run. And
 * because a flagged lane means the two ends differ in it, at least one side
 * always diverges in that lane — the note can never end up with both clauses
 * empty after the gate has opened.
 */
export function divergenceNote(
  from: GroupDivergenceInput | null,
  to: GroupDivergenceInput | null,
  labels: DivergenceLabels,
): string | null {
  // THE GATE: does this move change anything for the person being moved?
  const crossing = groupsDiverge(from, to);
  if (!crossing.pace && !crossing.content) return null;

  // …and then, per side, HOW each end differs from the run canonical.
  const fromOwn = groupsDiverge(null, from);
  const toOwn = groupsDiverge(null, to);
  const { source, target, who } = labels;

  const arriving: string[] = [];
  // Guarded on `target` as well as on the lanes: the pool reaches this with
  // `to === null`, so `toOwn` is already all-false, and the explicit check is
  // what keeps that a stated rule rather than a coincidence of the input.
  if (target !== null) {
    if (crossing.pace && toOwn.pace) arriving.push("runs on its own schedule");
    if (crossing.content && toOwn.content) {
      arriving.push("has its own version of some weeks");
    }
  }
  const leaving: string[] = [];
  if (crossing.pace && fromOwn.pace) leaving.push("schedule");
  if (crossing.content && fromOwn.content) leaving.push("content");

  if (arriving.length === 0) {
    // Nothing unusual about where they are going — the fact is what they are
    // giving up. The pool is named as the curriculum, never as a thing with
    // weeks of its own.
    const tail =
      target === null
        ? "the course curriculum applies from now on"
        : `${target}'s weeks and dates apply from now on`;
    return `${who} is leaving ${source}'s customised ${listOf(leaving)} — ${tail}.`;
  }

  // `arriving` is non-empty, so `target` is a real group and may be named.
  const opening =
    leaving.length === 0
      ? `${target} ${listOf(arriving)}, unlike ${source}`
      : `${who} is leaving ${source}'s customised ${listOf(leaving)}, and ` +
        `${target} ${listOf(arriving)}`;
  // "they" once `who` has already been the subject — the sentence names a
  // person twice otherwise.
  const subject = leaving.length === 0 ? who : "they";
  return (
    `${opening} — ${subject} may see different week numbers, dates and ` +
    `materials there, and progress is counted against ${target}'s weeks from now on.`
  );
}

// ---------------------------------------------------------------------------
// Server-side week resolution (routes and server components only)
// ---------------------------------------------------------------------------

/** The canonical week ref. Exported so writers and readers share one path. */
export function runWeekRef(
  db: Firestore,
  runId: string,
  weekId: string,
): DocumentReference {
  return db.collection("courseRuns").doc(runId).collection("weeks").doc(weekId);
}

/** The group-fork week ref — the copy-on-write target. */
export function groupWeekRef(
  db: Firestore,
  groupId: string,
  weekId: string,
): DocumentReference {
  return db.collection("courseGroups").doc(groupId).collection("weeks").doc(weekId);
}

export type ResolvedWeekRef = {
  ref: DocumentReference;
  source: WeekSource;
};

/**
 * The doc a read of (member's group, week) RESOLVES to right now: the fork
 * ref when the fork exists, else the canonical ref. Costs one read (the fork
 * existence probe) when `groupId` is set, none when it is null.
 *
 * NOT a write target: writers address `groupWeekRef` / `runWeekRef`
 * explicitly, because "write to wherever reads currently resolve" is exactly
 * the auto-fork-on-save behaviour decision 4 rejects.
 */
export async function resolveWeekRef(
  db: Firestore,
  runId: string,
  groupId: string | null,
  weekId: string,
): Promise<ResolvedWeekRef> {
  if (groupId) {
    const forkSnap = await groupWeekRef(db, groupId, weekId).get();
    if (forkSnap.exists) return { ref: forkSnap.ref, source: "group" };
  }
  return { ref: runWeekRef(db, runId, weekId), source: "run" };
}

/** A week that exists, tagged with which copy it came from. */
export type ResolvedWeekEntry =
  | { source: "run"; week: CourseWeekDoc }
  | { source: "group"; week: GroupWeekDoc };

/**
 * `resolveWeekDoc`'s answer: always an object (callers destructure `week`
 * without a null-check on the wrapper), with `week: null` only when neither
 * the fork nor the canonical doc exists.
 */
export type ResolvedWeek = ResolvedWeekEntry | { source: "run"; week: null };

/**
 * ONE week as this member sees it, normalised. Both reads go out in parallel
 * when a group is in play — most weeks are unforked, so the canonical read is
 * nearly always needed and the fork probe rides along in the same round trip.
 */
export async function resolveWeekDoc(
  db: Firestore,
  runId: string,
  groupId: string | null,
  weekId: string,
): Promise<ResolvedWeek> {
  const canonicalRef = runWeekRef(db, runId, weekId);
  if (!groupId) {
    const snap = await canonicalRef.get();
    if (!snap.exists) return { source: "run", week: null };
    return { source: "run", week: normalizeCourseWeek(snap.id, snap.data() ?? {}) };
  }
  const [forkSnap, canonicalSnap] = await Promise.all([
    groupWeekRef(db, groupId, weekId).get(),
    canonicalRef.get(),
  ]);
  if (forkSnap.exists) {
    return { source: "group", week: normalizeGroupWeek(forkSnap.id, forkSnap.data() ?? {}) };
  }
  if (!canonicalSnap.exists) return { source: "run", week: null };
  return {
    source: "run",
    week: normalizeCourseWeek(canonicalSnap.id, canonicalSnap.data() ?? {}),
  };
}

/**
 * EVERY week as this member sees it: the run's canonical list with the
 * group's forks overlaid by doc id, sorted by id (the "w01".."w60" zero-
 * padding makes that week order).
 *
 * A fork whose canonical counterpart has since been DELETED is still
 * included — the fork is that group's truth, and dropping it would vanish a
 * week its members may hold progress against (the exact orphaning the
 * schedule-change suite documents). Consumers that only want plan-listed
 * weeks filter by their resolved calendar, not in here.
 */
export async function resolveWeekDocs(
  db: Firestore,
  runId: string,
  groupId: string | null,
): Promise<ResolvedWeekEntry[]> {
  const canonicalQuery = db
    .collection("courseRuns")
    .doc(runId)
    .collection("weeks")
    .get();
  const forkQuery = groupId
    ? db.collection("courseGroups").doc(groupId).collection("weeks").get()
    : null;
  const [canonicalSnap, forkSnap] = await Promise.all([canonicalQuery, forkQuery]);

  const byId = new Map<string, ResolvedWeekEntry>();
  for (const doc of canonicalSnap.docs) {
    byId.set(doc.id, {
      source: "run",
      week: normalizeCourseWeek(doc.id, doc.data() ?? {}),
    });
  }
  for (const doc of forkSnap?.docs ?? []) {
    byId.set(doc.id, {
      source: "group",
      week: normalizeGroupWeek(doc.id, doc.data() ?? {}),
    });
  }
  return Array.from(byId.keys())
    .sort()
    .map((id) => byId.get(id) as ResolvedWeekEntry);
}
