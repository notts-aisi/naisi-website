import "server-only";

/**
 * `admissions-stage-release`: the note that goes out when the next part of a
 * round's form opens.
 *
 * ## It announces something that has already happened
 *
 * This job does NOT release anything. `isStageReleased`
 * (`src/lib/admissions/stageRelease.ts`) derives the release at read time, on
 * every serialisation of every stage, so the questions are already on the
 * applicant's form before this handler is reached. A tick that never ran, a
 * scheduler somebody switched off, a send that bounced: none of them can gate
 * a question behind an email. That is the whole reason the release lives in a
 * predicate and the announcement lives here, and it is why a missed send is a
 * missed email rather than a fairness incident.
 *
 * ## ONE MARKER PER RECIPIENT, exactly as the deadline reminder does
 *
 * `stagerel__{roundId}__{stageId}__{uid}`, claimed with `.create()` before
 * that person's send and stamped after it.
 *
 * An earlier shape claimed ONE marker for the whole stage and carried a
 * resume cursor on it. Two things were wrong with that, and both bit at the
 * size a real intake reaches rather than in a test:
 *
 *  1. **The attempt budget was spent on ordinary runs.** A claim is capped at
 *     three attempts, and a round bigger than one tick's send ceiling needs a
 *     re-claim per partial run. So a round over roughly ninety live
 *     applications used its three attempts up on healthy partial runs, was
 *     given up on with a "no send" failure it had not had, and the last
 *     applicants were never told. The budget, not the ceiling, was the binding
 *     constraint.
 *  2. **The cursor was one document written once per recipient.** Firestore
 *     sustains about one write per second per document, and the write was
 *     swallowed on failure, so under load the cursor quietly stopped moving
 *     and a re-claim re-mailed people who had already had the email.
 *
 * A per-recipient marker has neither problem: each person carries their own
 * attempt budget, their own skip reason and their own stamp, no document is
 * written more than a couple of times, and a run that stops halfway simply
 * finds the first half already marked next time.
 *
 * ## The order is claim, send, stamp
 *
 * `.create()` the person's marker BEFORE their send, `stampSent` after it. A
 * crash in between leaves an unstamped marker, which the re-claim rule picks
 * up on a later tick; the reverse order would turn the same crash into a
 * second copy.
 *
 * ## One bad recipient costs one recipient, and IS retried
 *
 * Every per-recipient step is inside a try/catch and the run carries on. A
 * send that failed leaves its own marker unstamped (`stampError` writes only
 * `lastError`), so the re-claim rule picks that one person up on a later tick
 * without touching anybody else. That is a change from the stage-marker
 * shape, which could not retry one person at all.
 *
 * ## Too late is not worth saying
 *
 * `maxLateHours` is 72, three times the deadline reminder's window, because
 * this is an announcement rather than a countdown: a stage that opened
 * yesterday is still news. Past that, ONE stage-level marker
 * (`stagerel__{roundId}__{stageId}`) is written already settled as
 * `skippedReason: "stale"` and nobody is mailed. It is written with
 * {@link createSettled} and never with `claim()`: it records a verdict rather
 * than authorising a side effect, so it must not spend an attempt. Neither
 * the tick nor the release button sends afterwards, because both re-derive
 * the same verdict from the same clock.
 *
 * ## Lateness is measured from when the stage could first be seen
 *
 * A stage may be scheduled for a date BEFORE the round's window opens (an
 * author sets every stage's date up front, then moves the opening back). Its
 * questions cannot be read until the round opens, so measuring lateness from
 * the schedule alone would stamp it stale on the very day it first became
 * visible. {@link stageAnnouncedAt} therefore takes the LATER of the two.
 *
 * ## A stage that opens WITH the round is not announced
 *
 * `releaseAt: null` means "this stage is the form". It becomes readable the
 * moment the round's window opens, which is the same moment the round's own
 * announcement, its public page and its apply link are the news. Mailing
 * "stage one is now open" to somebody already halfway through writing it
 * would be noise, so a stage with neither a schedule nor a manual release
 * claims no marker and sends nothing.
 *
 * ## Push
 *
 * The contract mirrors this send to push under the `courseDecisions`
 * category once that channel exists (PR32). This module imports no push
 * helper today and must not until then.
 */

import { type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  admissionApplicationUrl,
  sendAdmissionEmail,
  type AdmissionSendOutcome,
} from "@/lib/email/admissionEmails";
import {
  hasOptedOutOfCourseAnnouncements,
  memberNameOf,
} from "@/lib/email/courseFacilitatorEmails";
import { formatRoundDeadline, isRoundOpen } from "@/lib/admissions/window";
import {
  effectiveStageClose,
  isStageReleased,
  stageReleaseInstant,
} from "@/lib/admissions/stageRelease";
import { STAGES_SUBCOLLECTION } from "@/lib/admissions/roundRoutes";
import { getAdminDb } from "@/lib/firebase/admin";
import { APPLICATIONS_COLLECTION } from "@/lib/firestore/admissionApplications";
import {
  ROUNDS_COLLECTION,
  normalizeAdmissionRound,
  normalizeAdmissionStage,
  type AdmissionRoundDoc,
  type AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  claim,
  createSettled,
  errorText,
  stageRecipientMarker,
  stageReleaseMarker,
  stampError,
  stampSent,
  stampSkipped,
} from "@/lib/scheduler/markers";
import type { JobContext, JobRegistration, JobResult } from "../registry";

export const ADMISSIONS_STAGE_RELEASE_JOB_ID = "admissions-stage-release";

/** How many open rounds one tick will look at. Same cap as the reminders job. */
export const ROUND_SCAN_CAP = 20;

/** Applications fetched per page. Small enough to interleave budget checks. */
export const APPLICATION_PAGE_SIZE = 100;

/**
 * Who hears about a newly opened stage: everybody whose application is still
 * live on the round.
 *
 * `draft` is the person still writing. `submitted` is the person who sent an
 * earlier stage and now has more to write, and leaving them out would be the
 * one unforgivable version of this bug. Withdrawn and decided rows are out:
 * there is nothing for them to answer.
 */
export const NOTIFIED_STATUSES: readonly string[] = ["draft", "submitted"];

/** See the module header. Same reason, same terminal settle, as the reminders job. */
export const SENT_UNSTAMPED_REASON = "sent-unstamped";

/** The suppression list would not read, so nobody is mailed on that address. */
export const SUPPRESSION_UNREADABLE_REASON = "suppression-unreadable";

/**
 * WHY one stage's announcement did or did not go out on this run.
 *
 * The manual release lane renders one sentence per value, so every reason a
 * run can decline has to be nameable. Reporting them all as "already
 * announced" (which an earlier version did) tells an admin a flat untruth
 * about a round whose window is shut, and has them pressing the button again
 * looking for an explanation.
 *
 * `scheduler-off`, `job-off` and `failed` belong to the release route rather
 * than to this handler: they describe a run that never started.
 */
export type StageAnnouncementReason =
  /** The job made this stage's announcement on this run. */
  | "announced"
  /** Everybody live on the round already had it. */
  | "already-announced"
  /** The round's application window is not open, so there is nobody to tell. */
  | "round-not-in-window"
  /** `isStageReleased` says no, or the stage opens with the round. */
  | "stage-not-released"
  /** Past `maxLateHours`: an email about it is worse than silence. */
  | "too-late"
  /** The round is open and nobody holds a live application on it. */
  | "no-live-applications";

export type StageReleaseRunSummary = {
  /** Emails actually handed to the send pipeline and stamped. */
  sent: number;
  /** Claimed and consciously not mailed (suppressed, opted out, no address). */
  skipped: number;
  /** Stages dropped whole for being over `maxLateHours` late. */
  stale: number;
  /** Stages whose whole audience this run reached the end of. */
  stages: number;
  /** Rounds this run actually examined: open, and carrying stages. */
  rounds: number;
  /** Live applications this run looked at (draft or submitted). */
  audience: number;
  /**
   * People in that audience whose marker refused a claim, which on this job
   * means they had already been told. It is what separates "nothing to say"
   * from "nobody to say it to" on the release button's receipt.
   */
  alreadyDone: number;
  /**
   * What went wrong, per unit of work. Nothing in the per-recipient path
   * throws out of the handler. A failure with no applicant behind it (a page
   * read, a stage read) records `stage:{stageId}` rather than a uid.
   */
  failures: Array<{ uid: string; error: string }>;
};

function emptySummary(): StageReleaseRunSummary {
  return {
    sent: 0,
    skipped: 0,
    stale: 0,
    stages: 0,
    rounds: 0,
    audience: 0,
    alreadyDone: 0,
    failures: [],
  };
}

export type StageReleaseRun = {
  result: JobResult;
  summary: StageReleaseRunSummary;
  /**
   * The verdict on the ONE stage a scoped run was asked about, for the manual
   * release lane's receipt. Null on a full tick, which has no single subject,
   * and null when the round or the stage could not be read at all.
   */
  reason: StageAnnouncementReason | null;
};

/** The fields an announcement needs off an application document. */
type Candidate = {
  uid: string;
  email: string | null;
  displayName: string;
  status: string;
};

/**
 * Read a candidate off a raw application document.
 *
 * Four fields rather than `normalizeAdmissionApplication`: this job never
 * reads an answer, an availability mask or an evidence snapshot, and decoding
 * them for every row on a round would be work done to throw away. The `uid`
 * comes from the FIELD, never parsed out of the doc id, which is
 * construct-only by contract.
 */
function candidateFrom(snap: QueryDocumentSnapshot): Candidate | null {
  const data = snap.data() as Record<string, unknown>;
  const uid = typeof data.uid === "string" ? data.uid : "";
  if (!uid) return null;
  return {
    uid,
    email: typeof data.email === "string" && data.email ? data.email : null,
    displayName: typeof data.displayName === "string" ? data.displayName : "",
    // A row written without the field reads as a draft, which is what
    // `normalizeAdmissionApplication` decides too. Deciding it HERE rather
    // than in a Firestore filter is what lets the audience be two statuses
    // without a second query or an `in` filter.
    status: typeof data.status === "string" && data.status ? data.status : "draft",
  };
}

/** The rounds this run covers: one named round, or every open one. */
async function loadRounds(
  db: Firestore,
  roundId: string | undefined,
): Promise<AdmissionRoundDoc[]> {
  if (roundId) {
    const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
    if (!snap.exists) return [];
    return [normalizeAdmissionRound(snap.id, snap.data() ?? {})];
  }
  const query = await db
    .collection(ROUNDS_COLLECTION)
    .where("status", "==", "open")
    .limit(ROUND_SCAN_CAP)
    .get();
  return query.docs.map((doc) => normalizeAdmissionRound(doc.id, doc.data()));
}

/** One round's stages, in asked order, or the single named one. */
async function loadStages(
  db: Firestore,
  roundId: string,
  stageId: string | undefined,
): Promise<AdmissionStageDoc[]> {
  const stages = db
    .collection(ROUNDS_COLLECTION)
    .doc(roundId)
    .collection(STAGES_SUBCOLLECTION);
  if (stageId) {
    const snap = await stages.doc(stageId).get();
    if (!snap.exists) return [];
    return [normalizeAdmissionStage(snap.id, snap.data() ?? {})];
  }
  const all = await stages.get();
  return all.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order);
}

/**
 * The instant a stage actually became READABLE, or null when it rode the
 * round's own opening and there is therefore nothing to announce.
 *
 * A manual release wins, because it is the only one that can bring a release
 * FORWARD and because it is the moment somebody decided to publish. See
 * `stageRelease.ts`.
 *
 * Otherwise it is the LATER of the schedule and the round's `opensAt`. A
 * stage scheduled for a date the round had not yet opened on was not visible
 * to anybody on that date, so measuring the announcement's lateness from it
 * would stamp the stage stale on the day it first appeared.
 */
export function stageAnnouncedAt(
  stage: AdmissionStageDoc,
  round: Pick<AdmissionRoundDoc, "opensAt">,
): Date | null {
  const manual = stage.manualReleasedAt ?? null;
  if (manual) return manual;
  const scheduled = stageReleaseInstant(stage);
  if (scheduled === null) return null;
  const opensAt = round?.opensAt ?? null;
  if (opensAt && opensAt.getTime() > scheduled.getTime()) return opensAt;
  return scheduled;
}

/**
 * Everything one applicant's note needs, or a reason not to send it.
 *
 * Identical posture to the reminders job: a users read that fails falls back
 * to what the application recorded, an explicit courses opt-out is a refusal,
 * an unanswered preference is not, and a suppression list that will not read
 * fails CLOSED.
 */
async function resolveRecipient(
  db: Firestore,
  candidate: Candidate,
): Promise<{ to: string; name: string } | { skip: string }> {
  let optedOut = false;
  let name = candidate.displayName;
  let accountEmail: string | null = null;
  try {
    const snap = await db.collection("users").doc(candidate.uid).get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      optedOut = hasOptedOutOfCourseAnnouncements(data);
      name = memberNameOf(data) || candidate.displayName;
      accountEmail =
        typeof data.email === "string" && data.email ? data.email : null;
    }
  } catch {
    // Not a reason to refuse somebody a note about their own application.
  }
  if (optedOut) return { skip: "opted-out" };
  const to = candidate.email ?? accountEmail;
  if (!to) return { skip: "no-address" };
  let suppressed: boolean;
  try {
    suppressed = await isSuppressed(db, to);
  } catch {
    return { skip: SUPPRESSION_UNREADABLE_REASON };
  }
  if (suppressed) return { skip: "suppressed" };
  return { to, name };
}

/**
 * The handler, callable either from the tick or from the manual release route
 * (`opts.roundId` + `opts.stageId`).
 *
 * ONE implementation for both lanes, and the SAME per-recipient markers, so a
 * release pressed by hand and a tick that arrives a minute later cannot both
 * mail the round. Whichever wins a person's `.create()` mails that person;
 * the other finds the marker and moves on.
 */
export async function runAdmissionsStageRelease(
  ctx: JobContext,
  opts: { roundId?: string; stageId?: string } = {},
): Promise<StageReleaseRun> {
  const summary = emptySummary();
  const db = getAdminDb();
  if (!db) {
    return {
      result: { processed: 0, hasMore: false, note: "admin sdk unavailable" },
      summary,
      reason: null,
    };
  }

  // A run scoped to exactly one stage has a single subject, so it can report
  // ONE honest verdict. A full tick has no such subject and reports none.
  const scoped = opts.roundId !== undefined && opts.stageId !== undefined;
  let reason: StageAnnouncementReason | null = null;
  const say = (value: StageAnnouncementReason) => {
    if (scoped) reason = value;
  };

  const rounds = await loadRounds(db, opts.roundId);
  let hasMore = false;
  // Set when the ceiling or the wall clock stops the run: it ends the WHOLE
  // run rather than one stage, because the next stage would only be read to
  // refuse every applicant on it.
  let stopped = false;

  for (const round of rounds) {
    if (stopped) break;
    if (ctx.budget.expired()) {
      hasMore = true;
      break;
    }
    // The SHARED window predicate, the one the apply page and the submit
    // route use. Announcing a new question on a round nobody can answer is
    // worse than saying nothing.
    if (!isRoundOpen(round, ctx.now)) {
      say("round-not-in-window");
      continue;
    }

    let stages: AdmissionStageDoc[];
    try {
      stages = await loadStages(db, round.id, opts.stageId);
    } catch (err) {
      // Nothing claimed, so nothing lost but latency.
      const error = errorText(err, 200);
      summary.failures.push({ uid: `round:${round.id}`, error });
      ctx.log("could not read a round's stages", { roundId: round.id, error });
      hasMore = true;
      continue;
    }
    if (stages.length === 0) continue;
    summary.rounds += 1;

    for (const stage of stages) {
      if (ctx.budget.expired()) {
        hasMore = true;
        break;
      }
      // The authoritative predicate, not a date comparison of this job's own.
      if (!isStageReleased(stage, round, ctx.now)) {
        say("stage-not-released");
        continue;
      }
      const announcedAt = stageAnnouncedAt(stage, round);
      // Released with the round: the round's own opening was the news.
      if (announcedAt === null) {
        say("stage-not-released");
        continue;
      }
      // Clamped, because a `manualReleasedAt` written by the server a
      // fraction ahead of this tick's `now` is clock skew, not a stage that
      // opens in the future, and it must not read as one.
      const lateMs = Math.max(0, ctx.now.getTime() - announcedAt.getTime());

      if (lateMs > ctx.maxLateHours * 3_600_000) {
        say("too-late");
        try {
          const stamped = await stampStale(db, ctx, round, stage, announcedAt);
          if (stamped) summary.stale += 1;
        } catch (err) {
          summary.failures.push({
            uid: `stage:${stage.id}`,
            error: errorText(err, 200),
          });
        }
        continue;
      }

      const audienceBefore = summary.audience;
      const doneBefore = summary.alreadyDone;
      let outcome;
      try {
        outcome = await announceStage(db, ctx, { round, stage, summary });
      } catch (err) {
        // The page read threw before the loop could catch it. One stage's bad
        // luck is not the rest of the round's, and the next tick derives the
        // same work.
        const error = errorText(err, 200);
        summary.failures.push({ uid: `stage:${stage.id}`, error });
        ctx.log("a stage announcement did not run", {
          roundId: round.id,
          stageId: stage.id,
          error,
        });
        continue;
      }
      const audience = summary.audience - audienceBefore;
      const already = summary.alreadyDone - doneBefore;
      if (audience === 0) say("no-live-applications");
      else if (already === audience) say("already-announced");
      else say("announced");

      if (outcome.hasMore) hasMore = true;
      if (outcome.stop) {
        stopped = true;
        break;
      }
    }
  }

  const note =
    `stages ${summary.stages}, sent ${summary.sent}, skipped ${summary.skipped}` +
    `, stale ${summary.stale}` +
    (summary.failures.length > 0 ? `, failed ${summary.failures.length}` : "");
  return {
    result: {
      processed: summary.sent + summary.skipped + summary.stale,
      hasMore,
      note,
    },
    summary,
    reason,
  };
}

/**
 * Record a stage as announced too late, once.
 *
 * Written already settled rather than claimed: it authorises no side effect,
 * so spending one of the unit's three claim attempts to store an opinion the
 * job re-derives every tick would be the bug the per-recipient markers exist
 * to avoid, in miniature. Returns false when the verdict is already on file.
 */
async function stampStale(
  db: Firestore,
  ctx: JobContext,
  round: AdmissionRoundDoc,
  stage: AdmissionStageDoc,
  announcedAt: Date,
): Promise<boolean> {
  const marker = stageReleaseMarker(round.id, stage.id);
  const written = await createSettled(db, marker, {
    job: ADMISSIONS_STAGE_RELEASE_JOB_ID,
    reason: "stale",
    at: ctx.now,
  });
  if (!written) return false;
  ctx.log("dropped a stage announcement as stale", {
    roundId: round.id,
    stageId: stage.id,
    releasedAt: announcedAt.toISOString(),
  });
  return true;
}

/**
 * One stage's whole announcement: page the round, mail everybody live on it.
 *
 * `stop` means the caller should start no further stage and no further round.
 * `hasMore` is what the receipt reports and what makes the tick re-arm.
 *
 * NOTHING IN HERE THROWS. A page that will not read, a claim that will not
 * write, one bad address, a stamp that will not stick: each is recorded
 * against the unit of work it belongs to and the run carries on. There is no
 * stage-level claim to lose, so a run that stops halfway costs nothing but
 * the emails it did not get to.
 */
async function announceStage(
  db: Firestore,
  ctx: JobContext,
  args: {
    round: AdmissionRoundDoc;
    stage: AdmissionStageDoc;
    summary: StageReleaseRunSummary;
  },
): Promise<{ hasMore: boolean; stop: boolean }> {
  const { round, stage, summary } = args;
  const close = effectiveStageClose(stage, round);
  const applicationUrl = admissionApplicationUrl(round.id, "apply");

  let cursor: QueryDocumentSnapshot | null = null;

  for (;;) {
    // One equality filter and NO ordering: an `orderBy("submittedAt")` would
    // drop every draft (the field is null until submission) exactly as the
    // sparse-field rule warns, and the page cursor needs no order of its own.
    let query = db
      .collection(APPLICATIONS_COLLECTION)
      .where("roundId", "==", round.id)
      .limit(APPLICATION_PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);

    let page;
    try {
      page = await query.get();
    } catch (err) {
      const error = errorText(err, 200);
      summary.failures.push({ uid: `stage:${stage.id}`, error });
      ctx.log("could not read a page of applicants", {
        roundId: round.id,
        stageId: stage.id,
        error,
      });
      // Nothing is claimed at the stage level, so the next tick simply
      // re-derives this stage and skips whoever is already marked.
      return { hasMore: true, stop: false };
    }
    if (page.empty) break;

    for (const doc of page.docs) {
      const candidate = candidateFrom(doc);
      if (candidate === null) continue;
      if (!NOTIFIED_STATUSES.includes(candidate.status)) continue;
      summary.audience += 1;

      if (summary.sent >= ctx.maxPerTick || ctx.budget.expired()) {
        // Out of sends or out of time. Everybody already mailed carries their
        // own stamp, so a later tick starts again and reaches only the rest.
        return { hasMore: true, stop: true };
      }

      try {
        await mailCandidate(db, ctx, {
          round,
          stage,
          applicationUrl,
          deadline: close ? formatRoundDeadline(close) : undefined,
          candidate,
          summary,
        });
      } catch (err) {
        // The claim, the recipient lookup or a stamp threw. One person's bad
        // luck is not everybody else's.
        const error = errorText(err, 200);
        summary.failures.push({ uid: candidate.uid, error });
        ctx.log("a stage announcement did not go out", {
          roundId: round.id,
          stageId: stage.id,
          uid: candidate.uid,
          error,
        });
      }
    }

    if (page.docs.length < APPLICATION_PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }

  summary.stages += 1;
  return { hasMore: false, stop: false };
}

/** Claim, decide, send, stamp: one applicant on one stage. */
async function mailCandidate(
  db: Firestore,
  ctx: JobContext,
  args: {
    round: AdmissionRoundDoc;
    stage: AdmissionStageDoc;
    applicationUrl: string;
    deadline: string | undefined;
    candidate: Candidate;
    summary: StageReleaseRunSummary;
  },
): Promise<void> {
  const { round, stage, applicationUrl, deadline, candidate, summary } = args;

  const marker = stageRecipientMarker(round.id, stage.id, candidate.uid);
  const claimed = await claim(db, marker, {
    job: ADMISSIONS_STAGE_RELEASE_JOB_ID,
    policy: ctx.policy,
  });
  // Not ours: already told, already settled, in flight on another tick, or
  // out of attempts. Every one of those is somebody else's business, and it
  // is the same marker the release button claims.
  if (!claimed.claimed) {
    summary.alreadyDone += 1;
    return;
  }

  const resolved = await resolveRecipient(db, candidate);
  if ("skip" in resolved) {
    await stampSkipped(db, marker.id, resolved.skip, ctx.now);
    summary.skipped += 1;
    ctx.log("a stage announcement was not sent", {
      roundId: round.id,
      stageId: stage.id,
      uid: candidate.uid,
      reason: resolved.skip,
    });
    return;
  }

  let outcome: AdmissionSendOutcome;
  let failure: string | null = null;
  try {
    outcome = await sendAdmissionEmail({
      kind: "stage-released",
      to: resolved.to,
      name: resolved.name,
      roundLabel: round.label,
      stageLabel: stage.label,
      // The form, because the new questions are answered there.
      applicationUrl,
      ...(deadline ? { deadline } : {}),
      uid: candidate.uid,
      roundId: round.id,
    });
  } catch (err) {
    outcome = "failed";
    failure = errorText(err, 200);
  }

  if (outcome === "sent") {
    // Counted BEFORE the stamp, because the mail is on the wire either way
    // and a receipt that under-reports sends is a receipt that lies.
    summary.sent += 1;
    await stampSentOrSettle(db, ctx, marker.id, {
      roundId: round.id,
      stageId: stage.id,
      uid: candidate.uid,
    });
    return;
  }

  if (outcome === "suppressed") {
    await stampSkipped(db, marker.id, "suppressed", ctx.now);
    summary.skipped += 1;
    return;
  }

  // Left RECLAIMABLE on purpose: `stampError` writes only `lastError`, so an
  // unsent marker older than the re-claim window is picked up by a later
  // tick. One person's failed send is now one person's retry rather than a
  // whole stage's.
  const error = failure ?? "the send did not go out";
  summary.failures.push({ uid: candidate.uid, error });
  await stampError(db, marker.id, error);
  ctx.log("a stage announcement did not go out", {
    roundId: round.id,
    stageId: stage.id,
    markerId: marker.id,
    error,
  });
}

/**
 * Stamp a marker whose email HAS gone out, and make sure it stays stamped.
 *
 * `decideMarkerClaim` refuses a marker with `sentAt`, `failedAt` or
 * `skippedReason` set and nothing else, so a claimed marker left unstamped is
 * reclaimable: a later tick re-derives this person, wins the re-claim, and
 * mails them again. So the stamp gets a second attempt, and if that fails too
 * the marker is settled a way the re-claim rule will not touch. Same rule,
 * same reasoning, as the reminders job.
 */
async function stampSentOrSettle(
  db: Firestore,
  ctx: JobContext,
  markerId: string,
  where: { roundId: string; stageId: string; uid: string },
): Promise<void> {
  try {
    await stampSent(db, markerId);
    return;
  } catch (first) {
    ctx.log("a sent stage announcement could not be stamped, retrying once", {
      ...where,
      markerId,
      error: errorText(first, 200),
    });
  }

  try {
    await stampSent(db, markerId);
    return;
  } catch (second) {
    const error =
      "The announcement WAS sent. Its marker could not be stamped, so it is " +
      `settled as ${SENT_UNSTAMPED_REASON} to stop a later tick sending it ` +
      `again: ${errorText(second, 120)}`;
    await stampSkipped(db, markerId, SENT_UNSTAMPED_REASON, ctx.now);
    await stampError(db, markerId, error);
    ctx.log("a sent stage announcement could not be stamped", {
      ...where,
      markerId,
      error,
    });
  }
}

export const admissionsStageReleaseJob: JobRegistration = {
  id: "admissions-stage-release",
  label: "New questions released",
  description:
    "Tells everybody still live on a round when the next part of its form opens. The questions are released at read time whatever this job does, so a missed run delays a note and never holds a question back.",
  maxPerTick: 200,
  /**
   * Three days, against the reminders job's one. A countdown that arrives
   * after the deadline is worse than silence; an announcement that arrives a
   * day late is still the news, and the round is still open.
   */
  maxLateHours: 72,
  /**
   * The reminders job's window, because the unit of work is the same size:
   * one person's email. A stage that needs several ticks is several hundred
   * per-person claims, each of which is stamped within a second of being
   * taken, so nothing here needs a window long enough to cover a whole round.
   */
  reclaimAfterMinutes: 20,
  /**
   * SHIPS DARK, for the same reason as the deadline reminders: it emails
   * applicants, and `config/scheduler` reads a missing row as this default.
   * The owner arms it from Site status once a round's stages are authored and
   * a run has been proven on dev (docs/courses-ops.md).
   */
  enabledByDefault: false,
  async handler(ctx: JobContext): Promise<JobResult> {
    const { result } = await runAdmissionsStageRelease(ctx);
    return result;
  },
};
