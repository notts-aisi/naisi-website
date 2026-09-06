import { NextResponse } from "next/server";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { readInterruptedDestroyAudit } from "@/lib/firestore/destroyAudit";
import { isAddressableId, loadCirculation } from "@/lib/worksheets/access";
import {
  circulationDestroyBlockers,
  countCirculationDestroyTargets,
  type CirculationDestroyCounts,
} from "@/lib/worksheets/destroy";

/**
 * The destroy confirmation dialog's data for one circulation: LIVE counts of
 * everything that dies, read at request time. Never a cached or denormalised
 * number, because this is the last thing an admin reads before typing a title
 * into an irreversible action.
 *
 * ADMIN ONLY, and authorisation runs BEFORE the existence check, so nobody
 * learns which circulation ids exist by asking. Same bar as the destroy
 * itself, deliberately: the manifest exists to inform the destroy decision,
 * and the sender cannot make that decision (the owner's rule of 7 September
 * 2026 is that a circulation destroy is offered to admins only, never to the
 * sender), so they get no preview of it either.
 *
 * TWO READS, ONE ROUTE. `?probe=interrupted` answers with the subject and the
 * interrupted report ALONE, with no aggregation and no bucket listing, because a
 * page can afford to ask "did a destroy of this die half-way" on every visit,
 * while the counts are only wanted when somebody opens the danger zone.
 * Anything the probe omits is ABSENT from the payload rather than zeroed: the
 * client treats a missing counter as "not read", never as 0.
 *
 * BLOCKERS ARE NOT ONLY ABOUT THE CIRCULATION. A circulation has no state that
 * refuses a destroy (an open one is exactly the case an admin destroying a test
 * send has in front of them), but a manifest that cannot count one of the two
 * Storage folders does: see `circulationDestroyBlockers`. The counts it could
 * not read are absent from `counts` rather than zeroed, and the destroy route
 * refuses the same way, so the sentence and the refusal always agree.
 *
 * UI COPY CONTRACT for the two RETAINED counters, `counts.dataExportRows` and
 * `counts.emailSendRows`: counted but NEVER deleted. `emailSends` is the
 * append-only record of what was sent to whom and `dataExports` the
 * append-only record of which spreadsheets were taken off this circulation, so
 * the dialog must present both as entries that are KEPT. Everything else in
 * `counts` is destroyed.
 *
 * A GET, like the run's manifest, and unlike the destroy beside it: it writes
 * nothing, so it is not on the view-as guard list in
 * `tests/impersonation-guard.test.mjs` (the aggregate and recipients GETs are
 * absent for the same reason). Reading what somebody sees is what view-as is
 * for; the admin check above still applies, and an admin viewing as a member
 * is not an admin.
 */

type CirculationSubject = {
  id: string;
  /** What must be typed to confirm. */
  label: string;
  /**
   * The run manifest names the run's parent course here. A circulation has no
   * equivalent to say: its own title IS the copy of the worksheet's, and the
   * worksheet's title is not stored on the circulation document. Null rather
   * than a second rendering of the label.
   */
  context: string | null;
  status: string;
};

/** An earlier destroy of this circulation that never reached `completedAt`. */
type InterruptedReport = {
  auditId: string;
  /** ISO 8601: the wire has no Timestamp, and the client re-zones nothing. */
  startedAt: string | null;
  /** Display name, never an email (the audit row is PII-light). */
  startedByName: string | null;
  /** What that attempt had already removed when it stopped. */
  deleted: Record<string, number>;
};

export type CirculationDestroyManifest = {
  target: CirculationSubject;
  /**
   * Every counter that could be READ. A Storage folder whose listing failed is
   * ABSENT from this map, never 0: the client renders each key it is given as a
   * row, so a zero would say "there are none of these" about files nobody
   * counted. The matching blocker below says so in a sentence and the destroy is
   * refused until the listing works, so no admin is ever shown a manifest with a
   * silent hole in it.
   */
  counts: Partial<Record<keyof CirculationDestroyCounts, number>>;
  blockers: string[];
  interrupted: InterruptedReport | null;
};

/** The cheap read: `?probe=interrupted`. No counts, no blockers. */
export type CirculationInterruptedProbe = {
  target: CirculationSubject;
  interrupted: InterruptedReport | null;
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const { circulationId } = await ctx.params;

  // Authorisation BEFORE any existence check.
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const target: CirculationSubject = {
    id: circulation.id,
    label: circulation.title,
    context: null,
    status: circulation.status,
  };

  if (new URL(req.url).searchParams.get("probe") === "interrupted") {
    const probe: CirculationInterruptedProbe = {
      target,
      interrupted: await readInterrupted(db, circulationId),
    };
    return NextResponse.json(probe);
  }

  const [counts, interrupted] = await Promise.all([
    countCirculationDestroyTargets(db, getAdminStorage() ?? null, circulation),
    readInterrupted(db, circulationId),
  ]);

  const payload: CirculationDestroyManifest = {
    target,
    counts: readableCounts(counts),
    blockers: circulationDestroyBlockers(counts),
    interrupted,
  };
  return NextResponse.json(payload);
}

/**
 * The counters that answered, as numbers. A null (a Storage folder that would
 * not list) is DROPPED rather than sent as 0, which is the same rule the
 * `?probe=interrupted` form follows for everything it does not read: absent
 * means "not read", and only a number means a number.
 */
function readableCounts(
  counts: CirculationDestroyCounts,
): Partial<Record<keyof CirculationDestroyCounts, number>> {
  const out: Partial<Record<keyof CirculationDestroyCounts, number>> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") out[key as keyof CirculationDestroyCounts] = value;
  }
  return out;
}

/**
 * The interrupted report, with its timestamp turned into a string here rather
 * than at the audit module's boundary. `startedAt` crosses the wire as JSON,
 * where a Firestore Timestamp serialises as a pair of numbers nobody can
 * render, so whatever the audit module hands back is normalised to ISO 8601
 * (or to null) at this one point.
 */
async function readInterrupted(
  db: Firestore,
  circulationId: string,
): Promise<InterruptedReport | null> {
  const row = await readInterruptedDestroyAudit(db, "circulation", circulationId);
  if (!row) return null;
  return {
    auditId: row.auditId,
    startedAt: toIso(row.startedAt),
    startedByName: row.startedByName ?? null,
    deleted: toCounts(row.deleted),
  };
}

function toIso(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  const stamp = value as { toDate?: () => Date } | null | undefined;
  if (typeof stamp?.toDate === "function") return stamp.toDate().toISOString();
  return null;
}

/** Non-negative integers only. A NaN counter is a missing one, not a zero. */
function toCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
  }
  return out;
}
