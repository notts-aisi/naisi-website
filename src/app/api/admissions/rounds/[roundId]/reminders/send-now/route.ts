import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { canAuthorRounds, ROUNDS_COLLECTION } from "@/lib/admissions/roundRoutes";
import { normalizeAdmissionRound } from "@/lib/firestore/admissionRounds";
import {
  SCHEDULER_CONFIG_PATH,
  SCHEDULER_LAST_ERROR_MAX,
  jobStateFor,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import {
  ADMISSIONS_REMINDERS_JOB_ID,
  admissionsRemindersJob,
  runAdmissionsReminders,
} from "@/lib/scheduler/jobs/admissionsReminders";
import { errorText } from "@/lib/scheduler/markers";
import {
  jobDefaultEnabled,
  policyFor,
  type JobBudget,
} from "@/lib/scheduler/registry";

/**
 * How long a hand-pressed run may work for.
 *
 * Shorter than the tick's 28s: a person is watching a spinner, and anything
 * this run does not get to is picked up by the next tick or by pressing the
 * button again, both of which are marker-guarded.
 */
const MANUAL_BUDGET_MS = 20_000;

/**
 * Send this round's due deadline reminders NOW.
 *
 * ## Why the button exists at all
 *
 * The tick is new infrastructure with an external dependency (Cloud
 * Scheduler, a secret, a rollout) and the dates it matters on are named and
 * few. If a tick slips on one of them, this turns a missed deadline reminder
 * into a click. It is also what makes the whole scheduler lane safe to cut
 * under time pressure: with this button, deadline reminders degrade to a
 * committee member pressing send on three named days.
 *
 * ## It cannot double-send, because it is the SAME handler
 *
 * Not a copy of the job, and not a "send to everyone" escape hatch: it calls
 * `runAdmissionsReminders` with this round's id, so it derives the same due
 * dates from the same round, claims the same markers, and skips anybody the
 * tick has already mailed. Press it twice and the second press sends nothing.
 * A second implementation here would be a second code path through the one
 * thing on this platform that must not double-send.
 *
 * It also honours the same lateness rule, so it cannot be used to mail a
 * "closes in 7 days" reminder a week after the round shut: a due date over
 * `maxLateHours` old is stamped stale and nobody is mailed.
 *
 * ## What it refuses
 *
 *  - a view-as session, first, before anything is read;
 *  - anyone who may not author rounds (admin or `approveCourse`);
 *  - a round that is not open, because a draft round has no applicants and a
 *    closed one has no deadline left to remind anybody about;
 *  - the site-wide scheduler kill switch, which is usually off because
 *    something is actively going wrong;
 *  - the reminders job's OWN switch, which the tick honours too. That job
 *    ships dark (`enabledByDefault: false`), so without this check the manual
 *    lane would be a way to mail a whole round during the deliberate dark
 *    period before anybody armed it, and a way to sidestep a switch an admin
 *    turned off on purpose. Turning it on is one toggle on Site status.
 */
export async function POST(
  _req: Request,
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

  const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});

  if (round.archived || round.status !== "open") {
    return NextResponse.json(
      {
        error:
          "Reminders only go to people holding a draft on an open round. Open this round first.",
      },
      { status: 409 },
    );
  }
  if (round.closesAt === null) {
    return NextResponse.json(
      {
        error:
          "This round has no closing date, so there is no deadline to count back from.",
      },
      { status: 409 },
    );
  }
  if (round.reminderOffsets.length === 0) {
    return NextResponse.json(
      { error: "This round has no reminders on its schedule." },
      { status: 409 },
    );
  }

  const config = await readSchedulerConfig(db);
  if (!config.enabled) {
    return NextResponse.json(
      {
        error:
          "The scheduler is switched off site-wide. Turn it back on from Site status before sending by hand.",
      },
      { status: 409 },
    );
  }
  const jobState = jobStateFor(
    config,
    ADMISSIONS_REMINDERS_JOB_ID,
    jobDefaultEnabled(admissionsRemindersJob),
  );
  if (!jobState.enabled) {
    return NextResponse.json(
      {
        error:
          "Deadline reminders are switched off. Turn the Application deadline reminders job on under Site status, then send.",
      },
      { status: 409 },
    );
  }

  // The same limits a scheduled run gets. A manual lane on a looser policy
  // would be a second set of rules for the same markers.
  const now = new Date();
  const deadline = now.getTime() + MANUAL_BUDGET_MS;
  const budget: JobBudget = {
    remainingMs: () => deadline - Date.now(),
    expired: () => Date.now() >= deadline,
  };

  try {
    const { result, summary } = await runAdmissionsReminders(
      {
        now,
        budget,
        log: (message, extra) =>
          console.log(`[scheduler:${ADMISSIONS_REMINDERS_JOB_ID}] (send now) ${message}`, extra ?? ""),
        policy: policyFor(admissionsRemindersJob),
        maxPerTick: admissionsRemindersJob.maxPerTick,
        maxLateHours: admissionsRemindersJob.maxLateHours,
      },
      { roundId: round.id },
    );

    // Same bookkeeping the tick does, so the panel's "last run" for this job
    // tells the truth about a hand-sent batch too.
    await db
      .collection(SCHEDULER_CONFIG_PATH.collection)
      .doc(SCHEDULER_CONFIG_PATH.doc)
      .set(
        {
          jobs: {
            [ADMISSIONS_REMINDERS_JOB_ID]: {
              lastRunAt: FieldValue.serverTimestamp(),
              lastProcessed: result.processed,
              lastError: null,
              lastErrorAt: null,
            },
          },
        },
        { merge: true },
      );

    return NextResponse.json({
      ok: true,
      sent: summary.sent,
      skipped: summary.skipped,
      stale: summary.stale,
      failed: summary.failures.length,
      hasMore: result.hasMore,
    });
  } catch (err) {
    const message = errorText(err, SCHEDULER_LAST_ERROR_MAX);
    console.error(`[scheduler:${ADMISSIONS_REMINDERS_JOB_ID}] send now threw:`, err);
    return NextResponse.json(
      { error: `That send threw: ${message}` },
      { status: 500 },
    );
  }
}
