import { NextResponse } from "next/server";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  serialiseStage,
} from "@/lib/admissions/roundRoutes";
import { roundWindowState } from "@/lib/admissions/window";
import {
  jobStateFor,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import {
  ADMISSIONS_STAGE_RELEASE_JOB_ID,
  admissionsStageReleaseJob,
  runAdmissionsStageRelease,
  type StageAnnouncementReason,
} from "@/lib/scheduler/jobs/admissionsStageRelease";
import { errorText } from "@/lib/scheduler/markers";
import {
  jobDefaultEnabled,
  policyFor,
  type JobBudget,
} from "@/lib/scheduler/registry";

/**
 * How long the announcement half of a hand-pressed release may work for.
 *
 * Shorter than the tick's 28s: somebody is watching a spinner, the release
 * itself is already committed, and anything this run does not reach is picked
 * up by the next tick, which finds everybody already mailed carrying their own
 * stamped marker and reaches only the rest.
 */
const NOTICE_BUDGET_MS = 15_000;

/**
 * What the release did about telling people, and when it did nothing, why.
 *
 * `reason` is the whole point of this shape. "Nobody was emailed" has half a
 * dozen causes, and a console that reported them all the same way (an earlier
 * version said "already announced" to every one of them, including a round
 * whose window is shut) tells an admin something false and has them pressing
 * the button again looking for an explanation. Every value renders its own
 * sentence in `StagesSection`.
 *
 * Three of the values are this route's rather than the job's: `scheduler-off`
 * and `job-off` describe a run that was refused before it started, and
 * `failed` a run that threw. The rest come back from the handler.
 */
export type NoticeReason =
  | StageAnnouncementReason
  | "scheduler-off"
  | "job-off"
  | "failed";

type NoticeReport = {
  attempted: boolean;
  /** The job actually made this stage's announcement on this run. */
  announced: boolean;
  reason: NoticeReason;
  sent: number;
  skipped: number;
  failed: number;
  /** The stage opened too long ago for an announcement to be worth sending. */
  stale: number;
  hasMore: boolean;
  /** Plain words for the console, present only when nothing was attempted. */
  note?: string;
};

/**
 * Release a stage BY HAND, now, and tell the people on the round.
 *
 * An explicit POST, never a side effect of a GET. The stage's questions are
 * the one thing on this whole tree that cannot be un-served: once the wording
 * has been out, an applicant who read it early has thinking time nobody else
 * got. A read path that could stamp `manualReleasedAt` would mean a preview,
 * a bot or a mis-ordered render could publish an intake's questions, which is
 * why the field has exactly one writer and it is this handler.
 *
 * `manualReleasedAt` can only ever bring a release FORWARD: `isStageReleased`
 * treats a stamped manual release as released regardless of the schedule, and
 * there is no route that clears it. Pushing one back would be a promise this
 * site cannot keep.
 *
 * Idempotent: pressing it twice reports the release it already made rather
 * than moving the timestamp, so a double tap cannot make the questions look
 * newer than they were, and the second press sends no email.
 *
 * ## The announcement rides the SAME job as the tick
 *
 * After the stamp, this handler calls `runAdmissionsStageRelease` scoped to
 * this one stage. Not a copy of it: the same handler, claiming the same
 * `stagerel__{roundId}__{stageId}__{uid}` marker per person, so a release
 * pressed by hand and a tick arriving a minute later cannot both mail anybody.
 * Whichever wins a person's `.create()` mails that person and the other
 * moves on.
 *
 * The two halves are deliberately not one operation. The RELEASE is the
 * durable thing and it is already committed by the time the send is
 * attempted; the notice is a courtesy, so a scheduler that is switched off, a
 * Resend outage or a slow round can only cost an email. The response says
 * which of those happened rather than pretending the press failed.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ roundId: string; stageId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { roundId, stageId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canAuthorRounds(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});

  const stageRef = roundRef.collection(STAGES_SUBCOLLECTION).doc(stageId);
  const stageSnap = await stageRef.get();
  if (!stageSnap.exists) {
    return NextResponse.json({ error: "Stage not found" }, { status: 404 });
  }
  const stage = normalizeAdmissionStage(stageSnap.id, stageSnap.data() ?? {});

  if (stage.questions.length === 0) {
    return NextResponse.json(
      { error: "This stage has no questions on it yet, so there is nothing to release." },
      { status: 409 },
    );
  }

  if (round.status === "cancelled") {
    return NextResponse.json(
      { error: "This round is cancelled, so it is not asking anything else." },
      { status: 409 },
    );
  }

  /**
   * The SAME window predicate the announcement job gates on, so the button and
   * the job cannot disagree about whether this round is asking anything.
   *
   * All three refusals are the same argument at different points on the
   * clock. `inactive` (draft or archived) and `not-yet` are rounds nobody can
   * reach: stamping `manualReleasedAt` there does nothing today, and would
   * quietly publish the questions the moment the window opened, which is not
   * what a button called Release now says it does. `closed` is a round that
   * has stopped taking answers, so a fresh question is one nobody may answer,
   * and the announcement job would refuse the send in any case, leaving a
   * release that told nobody.
   */
  const window = roundWindowState(round, new Date());
  if (window.state !== "open") {
    return NextResponse.json(
      {
        error:
          window.state === "closed"
            ? "This round's application window has closed, so releasing another stage would ask a question nobody can answer."
            : "This round is not open yet, so its stages cannot be released. Open the round first.",
      },
      { status: 409 },
    );
  }

  if (stage.manualReleasedAt) {
    return NextResponse.json({
      ok: true,
      alreadyReleased: true,
      stage: serialiseStage(stage, true),
    });
  }

  await stageRef.update({
    manualReleasedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const after = await stageRef.get();
  const notice = await announce(db, roundId, stageId);

  return NextResponse.json({
    ok: true,
    alreadyReleased: false,
    stage: serialiseStage(normalizeAdmissionStage(after.id, after.data() ?? {}), true),
    notice,
  });
}

/**
 * Tell everybody live on the round, through the scheduler job.
 *
 * NEVER THROWS. The release is committed before this is called and must not
 * be reported as a failure because a send did not go out. Every refusal comes
 * back as a `note` the console can print.
 *
 * It honours the same two switches the tick honours. The site-wide one is
 * usually off because something is actively going wrong, and the job's own is
 * off until the owner arms it; a manual lane that ignored either would be a
 * way to mail a whole round during a deliberate dark period. The questions
 * are released either way, which is the point of deriving the release at read
 * time.
 */
async function announce(
  db: Firestore,
  roundId: string,
  stageId: string,
): Promise<NoticeReport> {
  const quiet = (reason: NoticeReason, note: string): NoticeReport => ({
    attempted: false,
    announced: false,
    reason,
    sent: 0,
    skipped: 0,
    failed: 0,
    stale: 0,
    hasMore: false,
    note,
  });

  try {
    const config = await readSchedulerConfig(db);
    if (!config.enabled) {
      return quiet(
        "scheduler-off",
        "The stage is released. Nobody was emailed: the scheduler is switched off site-wide.",
      );
    }
    const jobState = jobStateFor(
      config,
      ADMISSIONS_STAGE_RELEASE_JOB_ID,
      jobDefaultEnabled(admissionsStageReleaseJob),
    );
    if (!jobState.enabled) {
      return quiet(
        "job-off",
        "The stage is released. Nobody was emailed: the New questions released job is switched off under Site status.",
      );
    }

    const now = new Date();
    const deadline = now.getTime() + NOTICE_BUDGET_MS;
    const budget: JobBudget = {
      remainingMs: () => deadline - Date.now(),
      expired: () => Date.now() >= deadline,
    };

    const { result, summary, reason } = await runAdmissionsStageRelease(
      {
        now,
        budget,
        log: (message, extra) =>
          console.log(
            `[scheduler:${ADMISSIONS_STAGE_RELEASE_JOB_ID}] (release button) ${message}`,
            extra ?? "",
          ),
        policy: policyFor(admissionsStageReleaseJob),
        maxPerTick: admissionsStageReleaseJob.maxPerTick,
        maxLateHours: admissionsStageReleaseJob.maxLateHours,
      },
      { roundId, stageId },
    );

    // A scoped run always reaches one of the handler's verdicts unless the
    // round or the stage vanished between this route reading them and the
    // handler reading them again, which is a race rather than an outcome.
    if (reason === null) {
      return quiet(
        "failed",
        "The stage is released. The announcement did not run: the round or the stage could not be read back.",
      );
    }
    return {
      attempted: true,
      announced: reason === "announced",
      reason,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failures.length,
      stale: summary.stale,
      hasMore: result.hasMore,
    };
  } catch (err) {
    console.error(
      `[scheduler:${ADMISSIONS_STAGE_RELEASE_JOB_ID}] the release notice threw:`,
      err,
    );
    return quiet(
      "failed",
      `The stage is released. The announcement did not go out: ${errorText(err, 200)}`,
    );
  }
}
