import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  countRunDestroyTargets,
  readDestroyMarker,
  readInterruptedDestroy,
  runDestroyBlockers,
  type InterruptedDestroyReport,
  type RunDestroyCounts,
} from "@/lib/firestore/courseDeletion";
import { normalizeCourseRun, type CourseRunStatus } from "@/lib/firestore/courses";

/**
 * The destroy confirmation dialog's data: LIVE counts of everything that
 * dies, read at request time (aggregate count queries — never a cached or
 * denormalised number, because this page is the last thing an admin reads
 * before typing the run's name into an irreversible action).
 *
 * ADMIN ONLY — same bar as the destroy itself. The manifest exists to
 * inform the destroy decision, and approveCourse holders cannot make that
 * decision, so they get no preview of it either (a 403 here, not a
 * read-only manifest, keeps the two routes' audiences identical).
 *
 * `blockers` non-empty means the destroy WILL be refused (409) — the dialog
 * should render the sentences and disable the confirm input rather than
 * letting the admin type a name into a dead end. A run that is ALREADY
 * mid-destroy reports none: the engine evaluates blockers on a fresh destroy
 * only (re-blocking a resume would wedge an interrupted cascade forever), so
 * a manifest that kept reporting them would withhold a Resume button the
 * server would have honoured.
 *
 * `interrupted` is the other half of that: the run's own destroy marker names
 * its `courseDeletions` row, so a cascade that died mid-page is reported here
 * as `{ auditId, startedAt, startedByName, deleted }` and the Danger zone can
 * offer to resume it. Without it a half-destroyed run is discoverable only by
 * someone who already knows to look in the Firestore console.
 *
 * TWO READS, ONE ROUTE. `?probe=interrupted` answers with the subject and the
 * interrupted report ALONE — two document reads, no aggregation — because the
 * editor asks that question on every visit while the counts are only wanted
 * when somebody opens the danger-zone disclosure. Anything the probe omits is
 * absent from the payload rather than zeroed: the client treats a missing
 * counter as "not read", never as 0 (see useDestroy's `toCounts`).
 *
 * UI COPY CONTRACT for the two RETAINED counters, `counts.emailSendRows` and
 * `counts.dataExportRows`: counted but NEVER deleted. `emailSends` is the
 * append-only deliverability audit and `dataExports` the append-only record
 * of which spreadsheets were downloaded off this cohort, so the dialog must
 * present both as entries that will be KEPT, not as part of what dies.
 * `admissionSeatOffers` is released rather than deleted (see the counter's
 * own comment); everything else in `counts` is destroyed.
 */

type RunSubject = {
  id: string;
  label: string;
  courseTitle: string;
  status: CourseRunStatus;
};

export type DestroyManifest = {
  run: RunSubject;
  counts: RunDestroyCounts;
  blockers: string[];
  interrupted: InterruptedDestroyReport | null;
};

/** The cheap read: `?probe=interrupted`. No counts, no blockers. */
export type DestroyInterruptedProbe = {
  run: RunSubject;
  interrupted: InterruptedDestroyReport | null;
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  // Authorization BEFORE any existence check — a non-admin learns nothing
  // about which run ids exist.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const raw = runSnap.data() ?? {};
  const run = normalizeCourseRun(runSnap.id, raw);

  if (new URL(req.url).searchParams.get("probe") === "interrupted") {
    const probe: DestroyInterruptedProbe = {
      run: {
        id: run.id,
        label: run.label,
        courseTitle: run.courseTitle,
        status: run.status,
      },
      interrupted: await readInterruptedDestroy(db, raw),
    };
    return NextResponse.json(probe);
  }

  const [counts, blockers, interrupted] = await Promise.all([
    countRunDestroyTargets(db, run),
    // A resume is never re-blocked (see above) — the engine skips the check
    // for a marked run, and this route has to give the same answer or the
    // dialog refuses a destroy the server would run.
    readDestroyMarker(raw).destroying
      ? Promise.resolve<string[]>([])
      : runDestroyBlockers(db, run),
    readInterruptedDestroy(db, raw),
  ]);

  const payload: DestroyManifest = {
    run: {
      id: run.id,
      label: run.label,
      courseTitle: run.courseTitle,
      status: run.status,
    },
    counts,
    blockers,
    interrupted,
  };
  return NextResponse.json(payload);
}
