import "server-only";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { recomputeRollup, type RegisterFact } from "./attendanceRollup";
import type { ResolvedSession } from "./sessions";
import type { RegisterMember } from "./registerAccess";
import {
  attendanceDocId,
  normalizeCourseAttendance,
  type AttendanceStatus,
  type CourseAttendanceDoc,
} from "@/lib/firestore/courseAttendance";
import {
  courseEnrolmentId,
  type EnrolmentAttendanceRollup,
} from "@/lib/firestore/courseEnrolments";

/**
 * THE ENROLMENT MIRROR: rebuilding `courseEnrolments.attendance` from the
 * registers, inside the transaction that changed one of them.
 *
 * TWO CALLERS, ONE ARITHMETIC. The push stamps a register as pushed; the
 * admin's post-push edit changes marks on one that already is. Both then have
 * to leave every affected member's rollup correct, and a second
 * implementation of "correct" is how two numbers that must agree stop
 * agreeing. So both express their change as an OVERRIDE laid over what the
 * transaction read, and take the same recompute.
 *
 * ── ALL READS BEFORE ANY WRITE ──────────────────────────────────────────────
 * A Firestore transaction refuses a read after a write, so this is split in
 * two: `readMirrorPlan` does every read the recompute needs and returns the
 * writes; the caller applies them. That is also why the override exists at
 * all, rather than the caller writing first and this re-reading: the register
 * being changed cannot be read back inside the same transaction.
 *
 * ── THE FULL SET OF REGISTERS, ADDRESSED ────────────────────────────────────
 * Every session the group holds has a deterministic register id, so the read
 * is one `getAll` over ids built from `resolveSessions` rather than a query.
 * No index, no ordering surprise, and a session with no register yet simply
 * comes back missing, which is the same thing as a session nobody has marked.
 */

/** What one caller is changing about one register, laid over what was read. */
export type RegisterOverride = {
  /** Marks to apply. `null` clears the mark back to unmarked. */
  marks?: Map<string, AttendanceStatus | null>;
  /** The session-held switch, when this change moves it. */
  held?: boolean;
  /** The push stamp. Set when this change is what makes the register count. */
  pushedAt?: Date;
};

export type MirrorPlan = {
  /** Every register of this group that exists, by session key. */
  registers: Map<string, CourseAttendanceDoc>;
  /** One write per member whose rollup this change produced. */
  writes: Array<{ ref: DocumentReference; rollup: EnrolmentAttendanceRollup }>;
};

/**
 * Read every register of the group, apply the caller's override, and compute
 * the rollup each member's enrolment should now carry.
 *
 * Members whose enrolment document is missing are skipped rather than created:
 * a rollup is a mirror of a row that exists, and minting one here would invent
 * an enrolment nobody granted.
 */
export async function readMirrorPlan(
  tx: Transaction,
  db: Firestore,
  args: {
    runId: string;
    groupId: string;
    sessions: ResolvedSession[];
    members: RegisterMember[];
    /** Keyed by session key. */
    overrides?: Map<string, RegisterOverride>;
    now: Date;
  },
): Promise<MirrorPlan> {
  const { runId, groupId, sessions, members, now } = args;
  const overrides = args.overrides ?? new Map<string, RegisterOverride>();

  const registerRefs = sessions.map((s) =>
    db
      .collection("courseAttendance")
      .doc(attendanceDocId(runId, groupId, s.weekNumber, s.occurrence)),
  );
  const enrolmentRefs = members.map((m) =>
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, m.uid)),
  );

  // ONE `getAll` for each side. Both are addressed reads inside the
  // transaction, so both are covered by its consistency guarantee: a
  // concurrent mark on another session cannot make this recompute stale
  // without also aborting it.
  const [registerSnaps, enrolmentSnaps] = await Promise.all([
    registerRefs.length ? tx.getAll(...registerRefs) : Promise.resolve([]),
    enrolmentRefs.length ? tx.getAll(...enrolmentRefs) : Promise.resolve([]),
  ]);

  const registers = new Map<string, CourseAttendanceDoc>();
  for (const snap of registerSnaps) {
    if (!snap.exists) continue;
    const doc = normalizeCourseAttendance(snap.id, snap.data() ?? {});
    // Keyed by the DERIVED session key rather than by the position in the
    // request: `getAll` does answer in order, but a register landing under
    // the wrong session's key is a silent, plausible-looking lie.
    registers.set(doc.sessionKey, doc);
  }

  // Matched by DOC ID, not by result position, so nothing here rests on
  // `getAll` returning documents in the order it was asked for them.
  const uidByEnrolmentId = new Map(
    members.map((m) => [courseEnrolmentId(runId, m.uid), m.uid]),
  );
  const enrolmentByUid = new Map<string, DocumentReference>();
  for (const snap of enrolmentSnaps) {
    const uid = uidByEnrolmentId.get(snap.id);
    if (snap.exists && uid) enrolmentByUid.set(uid, snap.ref);
  }

  const writes: MirrorPlan["writes"] = [];
  for (const member of members) {
    const ref = enrolmentByUid.get(member.uid);
    if (!ref) continue;
    const facts: RegisterFact[] = [];
    for (const session of sessions) {
      const stored = registers.get(session.sessionKey);
      const override = overrides.get(session.sessionKey);
      // A session with no register and no override in play is a session
      // nobody has opened. It contributes nothing rather than an absence.
      if (!stored && !override) continue;
      const status = override?.marks?.has(member.uid)
        ? (override.marks.get(member.uid) ?? null)
        : (stored?.records[member.uid] ?? null);
      facts.push({
        sessionKey: session.sessionKey,
        weekNumber: session.weekNumber,
        occurrence: session.occurrence,
        held: override?.held ?? stored?.held ?? true,
        pushedAt: override?.pushedAt ?? stored?.pushedAt ?? null,
        status,
      });
    }
    writes.push({
      ref,
      rollup: recomputeRollup(facts, {
        joinedWeekNumber: member.joinedWeekNumber,
        now,
      }),
    });
  }

  return { registers, writes };
}
