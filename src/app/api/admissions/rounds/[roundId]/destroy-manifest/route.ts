import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  countRoundDestroyTargets,
  readInterruptedRoundDestroy,
  roundDestroyBlockers,
  type RoundDestroyCounts,
} from "@/lib/admissions/destroy";
import {
  ADMISSION_ROUND_KIND_LABEL,
  ROUNDS_COLLECTION,
  normalizeAdmissionRound,
} from "@/lib/firestore/admissionRounds";

/**
 * The destroy confirmation dialog's data for one admission round: LIVE counts
 * of everything that dies, read at request time. Never a denormalised number
 * and never `applicationCounts` off the round, because this is the last thing
 * somebody reads before typing a name into an action nothing reverses.
 *
 * ADMIN ONLY, the same bar as the destroy itself. The manifest exists to
 * inform the destroy decision, and an `approveCourse` holder who authors
 * rounds cannot make that decision, so they get no preview of it either: a
 * 403 here rather than a read-only manifest keeps the two routes' audiences
 * identical. Authorization runs BEFORE the existence check, so a non-admin
 * learns nothing about which round ids exist.
 *
 * `blockers` non-empty means the destroy WILL be refused (409), so the dialog
 * renders the sentences instead of offering the confirmation. A round with an
 * INTERRUPTED destroy reports none: the engine evaluates blockers on a fresh
 * destroy only, because re-blocking a resume would wedge a half-destroyed
 * round for good, and a manifest that kept reporting them would withhold a
 * Resume button the server would honour.
 *
 * `interrupted` is that other half. The audit row for this round with no
 * `completedAt` is durable evidence that a cascade began and stopped, so the
 * danger zone can offer to carry on rather than leaving a half-destroyed
 * round discoverable only by somebody who knows to open the Firestore
 * console.
 *
 * TWO READS, ONE ROUTE. `?probe=interrupted` answers with the subject and the
 * interrupted report alone, because the console asks that question on every
 * visit while the counts are wanted only once somebody opens the danger zone.
 * Anything the probe omits is ABSENT from the payload rather than zeroed: the
 * client treats a missing counter as "not read", never as 0.
 *
 * UI COPY CONTRACT for the two retained counters, `counts.emailSendRows` and
 * `counts.dataExportRows`: counted and never deleted. `emailSends` is the
 * append-only record of what was sent to whom and `dataExports` the
 * append-only record of which spreadsheets were taken off the platform, so
 * both must be presented as history that survives the round.
 * `memberRecordEntriesWritten` is the third that is not a deletion: it is how
 * many member records this destroy will WRITE before it removes anything.
 */

type RoundSubject = {
  id: string;
  /** What has to be typed to confirm. */
  label: string;
  /** The line under it: what kind of round, and which year. */
  context: string | null;
  status: string;
};

type InterruptedReport = {
  auditId: string;
  /** ISO 8601: the wire has no Timestamp, and the client re-zones nothing. */
  startedAt: string | null;
  startedByName: string | null;
  deleted: Record<string, number>;
};

export type RoundDestroyManifest = {
  target: RoundSubject;
  counts: RoundDestroyCounts;
  blockers: string[];
  interrupted: InterruptedReport | null;
};

/** The cheap read: `?probe=interrupted`. No counts, no blockers. */
export type RoundDestroyInterruptedProbe = {
  target: RoundSubject;
  interrupted: InterruptedReport | null;
};

/**
 * `startedAt` crosses the wire as an ISO string whatever the audit helper
 * hands back: a Firestore `Timestamp` serialises to `{ _seconds, … }`, which
 * the client reads as "no date" rather than as a date it cannot parse.
 */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  const stamp = value as { toDate?: () => Date } | null | undefined;
  if (typeof stamp?.toDate === "function") return stamp.toDate().toISOString();
  return null;
}

function subject(round: {
  id: string;
  label: string;
  kind: keyof typeof ADMISSION_ROUND_KIND_LABEL;
  academicYear: string;
  status: string;
}): RoundSubject {
  const context = [ADMISSION_ROUND_KIND_LABEL[round.kind], round.academicYear]
    .filter((part) => Boolean(part))
    .join(" · ");
  return {
    id: round.id,
    label: round.label,
    context: context || null,
    status: round.status,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});

  const raw = await readInterruptedRoundDestroy(db, roundId);
  const interrupted: InterruptedReport | null = raw
    ? {
        auditId: raw.auditId,
        startedAt: iso(raw.startedAt),
        startedByName: raw.startedByName ?? null,
        deleted: raw.deleted ?? {},
      }
    : null;

  if (new URL(req.url).searchParams.get("probe") === "interrupted") {
    const probe: RoundDestroyInterruptedProbe = {
      target: subject(round),
      interrupted,
    };
    return NextResponse.json(probe);
  }

  const payload: RoundDestroyManifest = {
    target: subject(round),
    counts: await countRoundDestroyTargets(db, round),
    // A resume is never re-blocked, and this route has to give the same
    // answer the engine will, or the dialog refuses a destroy the server
    // would run.
    blockers: interrupted ? [] : roundDestroyBlockers(round),
    interrupted,
  };
  return NextResponse.json(payload);
}
