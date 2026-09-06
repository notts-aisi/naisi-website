"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The client half of the deletion protocol — the manifest read, the destroy
 * POST, and the resume-until-complete loop that drives them.
 *
 * ── WHY THIS IS A HOOK AND NOT A MUTATION HELPER ────────────────────────────
 * Every other admin write in `features/courses` is one request that either
 * lands or doesn't, so it lives in `courseMutations.ts` and reports through the
 * page's ActionToast. A destroy is not that shape. It is:
 *
 *   read a manifest → show it → take a typed confirmation → run a cascade that
 *   may need SEVERAL round trips → survive the tab dying in the middle → and
 *   end with a receipt naming an audit record.
 *
 * That is a state machine with progress, so it holds state, so it is a hook.
 *
 * ── THE RESUME LOOP ─────────────────────────────────────────────────────────
 * `POST …/destroy` answers `{ ok, deleted, complete, auditId }`. `complete:
 * false` means the cascade hit its per-request page budget (Cloud Run caps a
 * request at 60s) and the IDENTICAL call must be repeated to carry on — the
 * route reads its own audit doc to know where it was. So the loop below simply
 * re-posts the same body until `complete` or until one of the two guards fires.
 *
 * The guards are lifted straight from `accountDeletion.ts`, which pages the
 * same way:
 *
 *   PAGE CEILING  — `MAX_PASSES`. `deleteOwnedCourseRows` throws rather than
 *                   returning quietly when its pages stop draining, because a
 *                   silent stop reports a clean teardown over rows that are
 *                   still there. Same here: spending the ceiling ends in
 *                   `stalled`, never in `done`.
 *   NO-PROGRESS   — a pass that reports zero rows removed AND `complete:
 *                   false` has told us it did nothing and is not finished.
 *                   Two of those in a row and the loop stops rather than
 *                   hammering the route forever. (Two, not one: a cascade that
 *                   walks several collections can legitimately spend a pass on
 *                   a collection that turns out to be empty.)
 *
 * Neither guard loses anything. A destroy is resumable BY CONSTRUCTION — the
 * audit doc is the cursor — so every failure state here offers Resume, and the
 * worst case is that an operator presses it again tomorrow.
 *
 * ── HOW `deleted` IS READ (and why this file does no arithmetic) ────────────
 * The response's `deleted` map IS the running total for this destroy: the
 * route returns the audit doc's accumulated counts, re-read after the pass's
 * own increments landed. So this file replaces its map with each response and
 * adds nothing up.
 *
 * That division of labour is forced by the resume requirement. A resume can
 * start in a DIFFERENT TAB from the one that began the cascade, and that tab
 * knows nothing about earlier passes — only the server can state honest
 * totals. It is also why the client must NOT sum the responses itself: a
 * retried request (a proxy timeout, an operator double-click) would then
 * double-count work that happened once.
 *
 * The receipt still never claims the numbers are the last word: it names the
 * audit doc as the authority and says so out loud when its totals fall short
 * of the manifest's.
 *
 * ── NOTHING HERE IS A PERMISSION CHECK ──────────────────────────────────────
 * Admin-only, blockers, byte-equal confirmation: all of it is re-decided by the
 * routes. This module exists so the operator sees the truth before deciding,
 * not so the client can decide.
 */

// ---------------------------------------------------------------------------
// Wire shapes — MIRRORED from the routes, deliberately not imported
// ---------------------------------------------------------------------------

/**
 * Why mirrored (the `StaffEmailComposer` precedent, for a different reason):
 *
 *  - There are TWO manifest routes, `runs/[runId]/destroy-manifest` and
 *    `[courseId]/destroy-manifest`, and they describe two different subjects.
 *    One client dialog renders both, so it needs a shape that is neither.
 *  - The interrupted-destroy report is an addition to the pinned manifest
 *    contract, and this file has to keep working against a route that hasn't
 *    grown it yet — a missing key means "no interrupted destroy", not a crash.
 *  - A server type alias is a claim, not a check. The parse below is the check,
 *    and it has to run whether or not a type was imported.
 *
 * Keep in step with the routes: `{ run | course | target, counts, blockers }`
 * plus the optional `interrupted`. An unrecognised COUNT key is not a drift
 * failure (see `countMeta()`), so the routes can gain counters independently.
 */

/**
 * What is being destroyed. The hook started with the two course subjects and
 * now serves four, because everything after the URL is identical: a manifest
 * read, a typed confirmation, a paged cascade and an audit row. The two
 * newcomers name their subject under `target` in the manifest payload, which
 * `parseManifest` already accepts alongside `run` and `course`.
 */
export type DestroyKind = "run" | "course" | "circulation" | "admission-round";

/** Live row counts, keyed by what they count. Values are non-negative ints. */
export type DestroyCounts = Record<string, number>;

/** What the manifest says the thing being destroyed actually is. */
export type DestroyTargetDescriptor = {
  id: string;
  /** The run's label / the course's title — what must be typed to confirm. */
  label: string;
  /** The run's course title; null for a course (it has no parent to name). */
  context: string | null;
  /** The run's `status` / the course's `status`, verbatim. */
  status: string | null;
};

/**
 * An earlier destroy of this same target that never reached `completedAt`.
 * Read from `courseDeletions/{auditId}` by the manifest route — the target's
 * own destroy marker names the row, so it is a document read rather than a
 * query, which is what makes the mount-time probe below affordable.
 */
export type InterruptedDestroy = {
  auditId: string;
  /** ISO string as it crossed the wire; rendered as-is, never re-zoned here. */
  startedAt: string | null;
  startedByName: string | null;
  /** What that attempt had already removed when it stopped. */
  deleted: DestroyCounts;
};

export type DestroyManifest = {
  target: DestroyTargetDescriptor;
  counts: DestroyCounts;
  /** Human sentences. Non-empty = the destroy must not be offered. */
  blockers: string[];
  interrupted: InterruptedDestroy | null;
};

// ---------------------------------------------------------------------------
// Count vocabulary
// ---------------------------------------------------------------------------

/**
 * What happens to the rows a counter counts. The dialog groups by this, and
 * the distinction is the whole reason the manifest is worth reading:
 *
 *   destroyed — gone, unrecoverably, when the cascade finishes.
 *   retained  — deliberately NOT deleted. `emailSends` is the append-only
 *               record of what was sent to whom; it is deliverability and
 *               abuse-handling evidence and outlives the thing it mentions.
 *               A counter for rows the destroy WRITES rather than removes
 *               (the member record entries an admission round copies out
 *               before it deletes anything) takes this fate too: what the
 *               reader needs from the fate is "this is on the surviving side
 *               of the line", and the row's note says which way it got there.
 *   orphaned  — survives, but loses the reference that named it. Templates are
 *               frozen snapshots (v2 decision 2, append-only); destroying the
 *               course they were taken from does not destroy them.
 */
export type CountFate = "destroyed" | "retained" | "orphaned";

type CountMeta = {
  label: string;
  fate: CountFate;
  /** Second line under the row, for the fates that owe an explanation. */
  note?: string;
};

/**
 * Display order and copy for every counter the destroy manifests are known to
 * report. Order is the order rows are shown in (roughly "structure, then
 * people, then the trail people left"), not alphabetical and not by size, so
 * the same destroy always reads the same way.
 *
 * FOUR SUBJECTS REPORT INTO THIS ONE MAP now, not two: the run, the course, a
 * worksheet circulation and an admission round. The map is not the courses
 * feature's private vocabulary any more, and the reason it has to hold every
 * subject's keys is `fate`. A key this map does not know falls back to
 * "destroyed" (see `countMeta`), which is the safe direction for something
 * that dies and a LIE for something that survives, so a counter naming a
 * survivor MUST have an entry here. `memberRecordEntriesWritten` is the one
 * that made the rule: it counts records the round destroy writes so the
 * committee keeps what it remembers about a person, and reporting it under
 * "what this removes" would contradict the owner's first rule about destroys
 * on the very screen that exists to state it.
 *
 * Per-subject WORDING can still be overridden where a shared sentence would be
 * about the wrong thing (see `EXTRA_COUNT_COPY` in
 * `src/features/destroy/DestroyPanel.tsx`); the fate never is.
 */
const COUNT_META: Record<string, CountMeta> = {
  runs: { label: "Runs", fate: "destroyed" },
  weeks: { label: "Week documents", fate: "destroyed" },
  groups: { label: "Groups", fate: "destroyed" },
  stages: {
    label: "Round stages",
    fate: "destroyed",
    note: "The round's own structure: each stage and the criteria it scored on.",
  },
  applications: {
    label: "Applications",
    fate: "destroyed",
    note: "Including every answer given on the application form.",
  },
  applicationPrivateRows: {
    label: "Access-requirements answers",
    fate: "destroyed",
    note: "What each applicant told us they need in order to take part. Stored apart from the application because fewer people may read it; it goes with the application it belongs to.",
  },
  enrolments: { label: "Enrolments", fate: "destroyed" },
  progress: {
    label: "Progress rows",
    fate: "destroyed",
    note: "Check-offs, ratings, private notes and the public comments the cohort wrote.",
  },
  exerciseResponses: {
    label: "Exercise answers",
    fate: "destroyed",
    note: "Member-authored text, with any facilitator review attached to it.",
  },
  attendanceRegisters: {
    label: "Attendance registers",
    fate: "destroyed",
    note: "Whole registers — one per group per week — not individual marks.",
  },
  materialNotes: {
    label: "Facilitator material notes",
    fate: "destroyed",
    note: "Staff assessments of how each piece of the curriculum landed — the written half of this run's retrospective. A snapshot saved from this run keeps its frozen summary; these notes do not survive.",
  },
  mirroredTasks: {
    label: "Mirrored My Work tasks",
    fate: "destroyed",
    note: "The week reminders this run wrote onto members' task boards.",
  },
  registerTasks: {
    label: "Unmarked-register follow-ups",
    fate: "destroyed",
    note: "The committee cards raised when one of this run's groups left a register unpushed, and any comments on them. The chase history goes with the run.",
  },
  subscriptionRows: {
    label: "Cohort email subscriptions",
    fate: "destroyed",
    note: "The rows on this run's cohort channel. Members' other subscriptions are untouched.",
  },
  admissionSeatOffers: {
    label: "Admission places on this cohort",
    fate: "orphaned",
    note: "KEPT and RELEASED. The applications themselves survive with everything the applicant wrote; each one is set to withdrawn and unlinked from this cohort, so it no longer claims a place that has stopped existing. An admin can reinstate any of them into a live round.",
  },
  auditRows: {
    label: "Course audit rows",
    fate: "destroyed",
    note: "The operational log for this run: registers pushed and edited, facilitators appointed and removed, drop-outs, the run being settled. Unlike the delivery log these describe rows this destroy is deleting, so they do not outlive it.",
  },
  schedulerMarkers: {
    label: "Scheduler send markers",
    fate: "destroyed",
    note: "The dedupe rows that record which timed sends this run's groups have already had. No member work and no addresses, but they have to go with the run: a marker left behind can suppress a real send later.",
  },
  reviewerFlagsCleared: {
    label: "Admissions reviewer flags",
    fate: "destroyed",
    note: "Committee members who lose the Admissions tab because this was the only round naming them as a reviewer. Their accounts, and their reviews on any other round, are untouched.",
  },
  memberRecordEntriesWritten: {
    label: "Member record entries",
    fate: "retained",
    note: "WRITTEN, NOT DELETED, and written before anything is removed. One entry per applicant on their own member record: when they applied, what for, the outcome, how they scored and the reviewers' notes. It hangs off the person rather than off the round, so it survives this destroy and every other.",
  },
  emailSendRows: {
    label: "Delivery-log rows",
    fate: "retained",
    note: "KEPT. `emailSends` is the append-only record of what was sent to whom — deliverability and abuse-handling evidence, and not this run's to erase.",
  },
  coursePages: {
    label: "Public course page",
    fate: "destroyed",
    note: "The authored programme page: the pitch, the weekly themes, the FAQ and the journey strip. Authored copy, not member work, and it goes with the course it describes.",
  },
  dataExportRows: {
    label: "Download-log rows",
    fate: "retained",
    note: "KEPT. `dataExports` is the append-only record of which spreadsheets were downloaded off this cohort and who asked for them. It holds no member content, and destroying what a file described does not undo the download.",
  },
  templates: {
    label: "Saved templates",
    fate: "orphaned",
    note: "KEPT. Frozen snapshots outlive the course they were taken from; they lose the link back to it.",
  },
};

/**
 * Aliases for the same fate under a different key name. The manifest routes are
 * written separately from this file, and a counter arriving as
 * `templatesOrphaned` rather than `templates` must not be reported as a
 * deletion — see the fallback rule below for why that direction matters.
 */
const COUNT_ALIASES: Record<string, string> = {
  templatesOrphaned: "templates",
  orphanedTemplates: "templates",
  emailSends: "emailSendRows",
  dataExports: "dataExportRows",
  subscriptions: "subscriptionRows",
};

const COUNT_ORDER = Object.keys(COUNT_META);

/** "attendanceRegisters" → "Attendance registers". */
function humanizeCountKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Copy + fate for one counter.
 *
 * An UNKNOWN key falls back to `destroyed`, and the direction is deliberate. If
 * this file is wrong about a counter, the two errors are not symmetrical:
 * calling a retained thing "destroyed" makes an admin more careful than they
 * needed to be, while calling a destroyed thing "retained" lets them press the
 * button believing something survives that doesn't. Only the first is
 * survivable, so the unknown case takes it.
 */
export function countMeta(key: string): CountMeta {
  const canonical = COUNT_ALIASES[key] ?? key;
  return COUNT_META[canonical] ?? { label: humanizeCountKey(key), fate: "destroyed" };
}

export type CountRow = CountMeta & { key: string; value: number };

/**
 * The manifest's counts as display rows, in `COUNT_ORDER` first and then
 * whatever else arrived (alphabetically, so an unknown counter has a stable
 * home). Zero-valued rows are KEPT: "0 attendance registers" is information —
 * it is the difference between "nothing was ever marked" and "this manifest
 * forgot to look".
 */
export function countRows(counts: DestroyCounts): CountRow[] {
  const keys = Object.keys(counts);
  const known = COUNT_ORDER.filter((k) => keys.includes(k));
  const extra = keys
    .filter((k) => !known.includes(k))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...extra].map((key) => ({
    key,
    value: counts[key] ?? 0,
    ...countMeta(key),
  }));
}

/** Sum of the rows that actually die — the denominator the progress bar uses. */
export function destroyedTotal(counts: DestroyCounts): number {
  return Object.entries(counts).reduce(
    (sum, [key, value]) => (countMeta(key).fate === "destroyed" ? sum + value : sum),
    0,
  );
}

/** Sum of every value in a `deleted` map (all of which are, by definition, gone). */
export function sumCounts(counts: DestroyCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Non-negative integers only. A NaN counter is a missing counter, not a zero. */
function toCounts(value: unknown): DestroyCounts {
  const raw = asRecord(value);
  if (!raw) return {};
  const out: DestroyCounts = {};
  for (const [key, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.floor(v);
    }
  }
  return out;
}

function toBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function toInterrupted(value: unknown): InterruptedDestroy | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const auditId = asString(raw.auditId) ?? asString(raw.id);
  // Without an audit id there is nothing to name and nothing to resume, so an
  // interrupted report we can't identify is treated as no report at all.
  if (!auditId) return null;
  return {
    auditId,
    startedAt: asString(raw.startedAt),
    startedByName: asString(raw.startedByName),
    deleted: toCounts(raw.deleted),
  };
}

/**
 * Normalise either manifest onto one client shape.
 *
 * The subject arrives under `run` on one route and (most likely) `course` on
 * the other; `target` is accepted too so a third naming can't break the dialog.
 * `fallbackLabel` is what the editor already knows the thing is called — used
 * only when the manifest doesn't say, so the typed confirmation still has
 * something to compare against.
 */
export function parseManifest(body: unknown, fallbackLabel: string): DestroyManifest {
  const raw = asRecord(body) ?? {};
  const subject =
    asRecord(raw.run) ?? asRecord(raw.course) ?? asRecord(raw.target) ?? {};
  return {
    target: {
      id: asString(subject.id) ?? "",
      label: asString(subject.label) ?? asString(subject.title) ?? fallbackLabel,
      context: asString(subject.courseTitle),
      status: asString(subject.status),
    },
    counts: toCounts(raw.counts),
    blockers: toBlockers(raw.blockers),
    interrupted: toInterrupted(raw.interrupted),
  };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Ceiling on round trips in one `destroy()` call. Each pass is a whole HTTP
 * request against a route that has already spent its own page budget, so this
 * is generous by design — it exists to stop an infinite loop, not to bound a
 * real cascade. The `accountDeletion` analogue is `COURSE_MAX_PAGES = 60`.
 */
const MAX_PASSES = 40;

/** Consecutive zero-row incomplete passes tolerated before the loop gives up. */
const MAX_IDLE_PASSES = 2;

export type DestroyPhase =
  | "idle"
  /** A pass is in flight. The dialog must not be dismissible in this state. */
  | "destroying"
  /** A pass failed. Resumable — nothing already removed is at risk. */
  | "failed"
  /** The loop stopped making progress, or spent its pass ceiling. */
  | "stalled"
  /** The route said `complete: true`. */
  | "done";

export type ManifestState = "idle" | "loading" | "ready" | "error";

/**
 * How a failed pass should be described.
 *
 * `refused` — the route answered under 500 with a sentence of its own (a bad
 * confirmation, a blocker, not signed in). Those checks all run before the
 * cascade touches anything, so nothing moved and the sentence is the whole
 * story.
 * `unknown` — a 5xx, no response, an unparseable one. The pass may have removed
 * rows before it died. Not a disaster (the audit doc records what went, and the
 * next pass carries on from there) but the copy must not pretend to know.
 */
export type PassFailure = { kind: "refused" | "unknown"; message: string };

export type UseDestroy = {
  manifest: DestroyManifest | null;
  manifestState: ManifestState;
  manifestError: string | null;
  /**
   * Fetch the FULL manifest — every live count, the blockers, the interrupted
   * report. Ten-ish aggregation queries, so callers keep it behind the
   * danger-zone disclosure and the dialog. Safe to call repeatedly; the last
   * call wins.
   */
  loadManifest: () => Promise<DestroyManifest | null>;
  /**
   * The cheap read (`?probe=interrupted`): two document reads, no counts, no
   * blockers. This is what a page visit pays so the interrupted banner can
   * appear without anybody opening anything.
   */
  loadInterrupted: () => Promise<InterruptedDestroy | null>;
  /**
   * The interrupted report from whichever read ran last — the probe on mount,
   * or the full manifest once it is asked for. One field so a surface never
   * has to know which read produced it.
   */
  interrupted: InterruptedDestroy | null;

  phase: DestroyPhase;
  /** Running totals, merged monotonically across passes. */
  deleted: DestroyCounts;
  deletedTotal: number;
  /** Denominator for the progress copy — never smaller than `deletedTotal`. */
  estimatedTotal: number;
  /** Completed round trips in this destroy, including resumes. */
  passes: number;
  auditId: string | null;
  failure: PassFailure | null;
  /** True once a pass has answered `complete: true`. */
  complete: boolean;

  /** Run (or resume) the cascade. `confirmName` is re-sent on every pass. */
  destroy: (confirmName: string) => Promise<void>;
  /** Back to `idle`, keeping the manifest. For closing the dialog. */
  reset: () => void;
};

export function useDestroy(kind: DestroyKind, targetId: string, fallbackLabel: string): UseDestroy {
  const [manifest, setManifest] = useState<DestroyManifest | null>(null);
  const [manifestState, setManifestState] = useState<ManifestState>("idle");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedDestroy | null>(null);

  const [phase, setPhase] = useState<DestroyPhase>("idle");
  const [deleted, setDeleted] = useState<DestroyCounts>({});
  const [passes, setPasses] = useState(0);
  const [auditId, setAuditId] = useState<string | null>(null);
  const [failure, setFailure] = useState<PassFailure | null>(null);

  const urls = useMemo(() => {
    // One base per kind, and every kind answers `{base}/destroy-manifest` and
    // `{base}/destroy` with the same two contracts. A total record rather than
    // a ternary chain: a fifth subject is one line, and until it has one the
    // types refuse the build instead of quietly routing it at the courses tree.
    const id = encodeURIComponent(targetId);
    const bases: Record<DestroyKind, string> = {
      run: `/api/courses/runs/${id}`,
      course: `/api/courses/${id}`,
      circulation: `/api/worksheets/circulations/${id}`,
      "admission-round": `/api/admissions/rounds/${id}`,
    };
    const base = bases[kind];
    return { manifest: `${base}/destroy-manifest`, destroy: `${base}/destroy` };
  }, [kind, targetId]);

  // Guards against a stale in-flight manifest landing on top of a newer one,
  // and against either landing after unmount.
  const manifestSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The loop reads and writes these directly: a resume has to continue from
  // what earlier passes reported, and React state inside an await chain is a
  // snapshot from the render that started it.
  const deletedRef = useRef<DestroyCounts>({});
  const passesRef = useRef(0);
  const runningRef = useRef(false);

  const loadManifest = useCallback(async (): Promise<DestroyManifest | null> => {
    const seq = manifestSeq.current + 1;
    manifestSeq.current = seq;
    setManifestState("loading");
    setManifestError(null);
    try {
      // Same-origin, so the session cookie rides along without `credentials`.
      const res = await fetch(urls.manifest, { headers: { Accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const message =
          asString(asRecord(body)?.error) ?? `Couldn't read the manifest (${res.status}).`;
        throw new Error(message);
      }
      const parsed = parseManifest(body, fallbackLabel);
      if (!alive.current || manifestSeq.current !== seq) return parsed;
      setManifest(parsed);
      // The full read is also the freshest answer to the interrupted question,
      // including "there isn't one any more".
      setInterrupted(parsed.interrupted);
      setManifestState("ready");
      return parsed;
    } catch (err) {
      if (!alive.current || manifestSeq.current !== seq) return null;
      setManifestError(err instanceof Error ? err.message : "Couldn't read the manifest.");
      setManifestState("error");
      return null;
    }
  }, [urls.manifest, fallbackLabel]);

  /**
   * The mount-time probe. Deliberately quiet: it sets no `manifestState` and
   * reports no error, because nothing is waiting on it — a failed probe means
   * the banner does not appear, and the full manifest (which the operator is
   * about to ask for) reports the same field properly, with an error surface
   * behind it.
   */
  const loadInterrupted = useCallback(async (): Promise<InterruptedDestroy | null> => {
    try {
      const res = await fetch(`${urls.manifest}?probe=interrupted`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as unknown;
      const found = toInterrupted(asRecord(body)?.interrupted);
      if (alive.current) setInterrupted(found);
      return found;
    } catch {
      return null;
    }
  }, [urls.manifest]);

  const destroy = useCallback(
    async (confirmName: string) => {
      // Re-entry would double-post the same pass. The ref (not `phase`) is the
      // guard because two calls in the same tick share a render's state.
      if (runningRef.current) return;
      runningRef.current = true;
      setPhase("destroying");
      setFailure(null);

      let idle = 0;
      try {
        for (let pass = 0; pass < MAX_PASSES; pass += 1) {
          // The dialog is gone: stop POSTing. Every state setter below is
          // already unmount-guarded, but a loop that kept firing requests into
          // a dead component would carry on deleting rows nobody is watching —
          // and the cascade is resumable by construction, so quitting between
          // passes loses nothing that the next visit's banner won't offer back.
          if (!alive.current) return;
          const res = await fetch(urls.destroy, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmName }),
          });
          const body = asRecord((await res.json().catch(() => null)) as unknown);

          if (!res.ok) {
            const sentence = asString(body?.error);
            // Under 500 with a sentence = a refusal decided before the cascade
            // ran. Anything else may have removed rows before it died.
            const refused = res.status < 500 && sentence !== null;
            setFailure({
              kind: refused ? "refused" : "unknown",
              message: sentence ?? `The destroy pass failed (${res.status}).`,
            });
            setPhase("failed");
            return;
          }

          // The response IS the running total (see the file header), so it
          // REPLACES what we held rather than merging into it.
          const before = sumCounts(deletedRef.current);
          const incoming = toCounts(body?.deleted);
          deletedRef.current = incoming;
          passesRef.current += 1;
          const nextAuditId = asString(body?.auditId);
          if (nextAuditId) setAuditId(nextAuditId);
          setDeleted(incoming);
          setPasses(passesRef.current);

          if (body?.complete === true) {
            setPhase("done");
            return;
          }

          // The total did not move AND the cascade is not finished: this pass
          // did nothing. One is forgivable (an empty collection in a
          // multi-collection cascade); two in a row is the `accountDeletion`
          // "did not drain" signal, and continuing would just hammer the
          // route. Compared as totals rather than "was this response zero",
          // because a running total never comes back as zero once anything
          // has gone.
          idle = sumCounts(incoming) <= before ? idle + 1 : 0;
          if (idle >= MAX_IDLE_PASSES) {
            setFailure({
              kind: "unknown",
              message:
                "The last two passes removed nothing but reported more still to do. Stopped rather than retrying blindly — resume it, and if it repeats the audit record is the place to look.",
            });
            // (Both guards below leave the destroy resumable: the marker and
            // the open audit row survive, so Resume picks up where this left.)
            setPhase("stalled");
            return;
          }
        }

        setFailure({
          kind: "unknown",
          message: `Stopped after ${MAX_PASSES} passes with the cascade still reporting more to do. Nothing is lost — resume to carry on.`,
        });
        setPhase("stalled");
      } catch (err) {
        // Network-level: the request never completed, so whether the server ran
        // the pass is genuinely unknown.
        setFailure({
          kind: "unknown",
          message:
            err instanceof Error
              ? `The destroy pass didn't complete: ${err.message}`
              : "The destroy pass didn't complete.",
        });
        setPhase("failed");
      } finally {
        runningRef.current = false;
      }
    },
    [urls.destroy],
  );

  const reset = useCallback(() => {
    // Never while a pass is in flight — the loop would keep writing into state
    // the caller has decided is finished.
    if (runningRef.current) return;
    deletedRef.current = {};
    passesRef.current = 0;
    setDeleted({});
    setPasses(0);
    setAuditId(null);
    setFailure(null);
    setPhase("idle");
  }, []);

  /**
   * A tab closed mid-cascade leaves a `completedAt: null` audit doc, which the
   * manifest surfaces on the next visit — so this is a nudge, not a safety
   * net. It is still worth having: the resume is one click from here and a
   * scavenger hunt from a fresh page load.
   */
  useEffect(() => {
    if (phase !== "destroying") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [phase]);

  const deletedTotal = sumCounts(deleted);
  // Manifest counts are taken BEFORE the cascade, so on a resume they describe
  // only what is left; the interrupted report says what already went. The max()
  // then stops the ratio ever reading "1,900 of ~250" if either is off.
  // The receipt also carries stage keys whose fate is not `destroyed` (the
  // released admission places), so the numerator can legitimately exceed a
  // denominator built from the destroyed counters alone. The max() below
  // already absorbs that; it is noted here so the next reader knows it is
  // understood rather than missed.
  const manifestTotal = manifest ? destroyedTotal(manifest.counts) : 0;
  const alreadyGone = interrupted ? sumCounts(interrupted.deleted) : 0;
  const estimatedTotal = Math.max(manifestTotal + alreadyGone, deletedTotal);

  return {
    manifest,
    manifestState,
    manifestError,
    loadManifest,
    loadInterrupted,
    interrupted,
    phase,
    deleted,
    deletedTotal,
    estimatedTotal,
    passes,
    auditId,
    failure,
    complete: phase === "done",
    destroy,
    reset,
  };
}

export default useDestroy;
