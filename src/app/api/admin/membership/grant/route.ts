import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { FIELD_LIMITS, canManageMembership } from "@/lib/firestore/users";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  MembershipYearCapError,
  TIER_COUNTS_AS_MEMBER,
  addPaidMembershipYear,
  isMembershipMatchedOn,
  isMembershipSource,
  isMembershipTier,
  membershipId,
  removePaidMembershipYear,
  type MembershipTier,
} from "@/lib/firestore/memberships";

/**
 * Grant or revoke one person's membership for one period.
 *
 * ## The row and the cache move together, or not at all
 *
 * A grant writes TWO things: the `memberships/{uid}__{periodId}` row, which is
 * the record (tier, source, how they were matched, who granted it), and the
 * `users.paidMembershipYears` entry, which is the queryable CACHE every
 * existing badge already reads. They are written in ONE transaction, because
 * a half-applied grant is the worst of both: a record nobody can see, or a
 * badge with nothing behind it. This route is the only writer of that cache;
 * `adminMutations.setPaidMembership` is gone, and a repo guard test keeps it
 * that way.
 *
 * ## The cap is checked BEFORE the write, and refuses by name
 *
 * `normalizeUser` keeps `FIELD_LIMITS.maxPaidMembershipYears` entries. Writing
 * an eleventh anyway would push one off the end and a member would simply stop
 * having a badge, with nothing anywhere saying why, so the transaction
 * pre-checks the count and refuses with `MembershipYearCapError` rather than
 * truncating. (`normalizeUser` also sorts newest-first before its slice now,
 * so even a document that grew past the cap by hand keeps the CURRENT year.)
 *
 * ## alumni is a row with no cache entry
 *
 * `TIER_COUNTS_AS_MEMBER` is applied here, at write time. An alumni grant
 * records a true fact about a person and deliberately does NOT enter the
 * cache, because they are not a member of the society this year. Re-granting
 * an existing paid row as alumni therefore REMOVES the cache entry in the same
 * transaction, which is why the cache is rewritten from the row's tier rather
 * than merely added to.
 *
 * ## Revoke deletes
 *
 * A revoke removes the row and the cache entry together. The alternative, a
 * `revokedAt` stamp, would leave a row that reads as a membership to anything
 * that forgot to check the field, and a mis-recorded membership is not history
 * worth keeping. The audit of who did it is the period's totals moving and the
 * admin who pressed it knowing they did.
 *
 * This route ADMINISTERS membership and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */
export async function POST(req: Request) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canManageMembership(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let body: {
    uid?: unknown;
    periodId?: unknown;
    tier?: unknown;
    source?: unknown;
    matchedOn?: unknown;
    revoke?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const periodId = typeof body.periodId === "string" ? body.periodId.trim() : "";
  if (!uid || !periodId) {
    return NextResponse.json(
      { error: "Name the member and the membership period." },
      { status: 400 },
    );
  }

  const revoke = body.revoke === true;
  const tier = body.tier;
  if (!revoke && !isMembershipTier(tier)) {
    return NextResponse.json(
      { error: "Pick a tier: paid, comped, alumni or staff." },
      { status: 400 },
    );
  }
  // `manual` is what a grant from the admin Members row is. The import (PR28)
  // is the only caller that will send anything else, and an unrecognised value
  // falls back rather than being stored as junk provenance.
  const source = isMembershipSource(body.source) ? body.source : "manual";
  const matchedOn = isMembershipMatchedOn(body.matchedOn) ? body.matchedOn : "manual";

  const periodRef = db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId);
  const membershipRef = db
    .collection(MEMBERSHIPS_COLLECTION)
    .doc(membershipId(uid, periodId));
  const userRef = db.collection("users").doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const [periodSnap, membershipSnap, userSnap] = await Promise.all([
        tx.get(periodRef),
        tx.get(membershipRef),
        tx.get(userRef),
      ]);

      if (!periodSnap.exists) throw new NotFound("No such membership period");
      if (!userSnap.exists) throw new NotFound("No such member");

      const year = periodSnap.data()?.year;
      if (typeof year !== "string" || year === "") {
        throw new NotFound("That membership period has no academic year on it");
      }

      const rawCache = userSnap.data()?.paidMembershipYears;
      const cache = Array.isArray(rawCache)
        ? rawCache.filter((y): y is string => typeof y === "string")
        : [];

      const previousTier = membershipSnap.exists
        ? membershipSnap.data()?.tier
        : undefined;
      const previous = isMembershipTier(previousTier) ? previousTier : null;

      if (revoke) {
        const years = removePaidMembershipYear(cache, year);
        // A cache entry with NO row behind it is a real state, not a bug: the
        // deleted `setPaidMembership` tagged the year client-direct and wrote
        // no row, so every member tagged before this PR looks exactly like
        // this. Revoke has to clear it or that badge could never be taken off.
        if (years.length !== cache.length) {
          tx.update(userRef, { paidMembershipYears: years });
        }
        if (!membershipSnap.exists) {
          // Nothing more to take away. Reported rather than 404'd: two admins
          // pressing revoke on the same row should both see the state they
          // wanted, and the row is already gone.
          return { revoked: false, tier: null, years };
        }
        tx.delete(membershipRef);
        if (previous) {
          tx.update(periodRef, { [`totals.${previous}`]: FieldValue.increment(-1) });
        }
        return { revoked: true, tier: null, years };
      }

      const nextTier = tier as MembershipTier;
      // Rewritten from the tier rather than merely added to: a paid row
      // re-granted as alumni has to LOSE its cache entry in the same write.
      const years = TIER_COUNTS_AS_MEMBER[nextTier]
        ? addPaidMembershipYear(cache, year, FIELD_LIMITS.maxPaidMembershipYears)
        : removePaidMembershipYear(cache, year);

      tx.set(membershipRef, {
        uid,
        periodId,
        tier: nextTier,
        source,
        matchedOn,
        provenance: {
          at: FieldValue.serverTimestamp(),
          byUid: user.uid,
        },
      });
      tx.update(userRef, { paidMembershipYears: years });

      // Cached per-tier counts, so the console can show them without reading
      // every row. A re-grant at the same tier moves nothing.
      if (previous !== nextTier) {
        const totals: Record<string, FirebaseFirestore.FieldValue> = {
          [`totals.${nextTier}`]: FieldValue.increment(1),
        };
        if (previous) totals[`totals.${previous}`] = FieldValue.increment(-1);
        tx.update(periodRef, totals);
      }

      return { revoked: false, tier: nextTier, years };
    });

    return NextResponse.json({
      uid,
      periodId,
      tier: result.tier,
      revoked: result.revoked,
      paidMembershipYears: result.years,
    });
  } catch (err) {
    if (err instanceof NotFound) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof MembershipYearCapError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[membership/grant] failed:", uid, periodId, err);
    return NextResponse.json({ error: "Could not save that membership." }, { status: 500 });
  }
}

/** Thrown inside the transaction so a missing period, a missing member and a
 *  period with no year all leave the transaction the same way and are answered
 *  with the same status. */
class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}
